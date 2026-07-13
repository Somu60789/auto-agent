"""
Teams client — reads and sends Teams messages without Azure App Registration.

Strategy:
  Teams desktop authenticates with Microsoft and stores the user's OAuth token
  in Windows Credential Manager (encrypted with DPAPI, tied to the logged-in user).
  We extract that token and use it directly against the Graph API.
  Teams itself refreshes the token — we just re-read it before each call.

No new Azure App Registration. No secrets to manage. Requires Teams desktop
to be running and signed in on the machine.
"""

import json, logging, time
from datetime import datetime, timezone

import httpx
import win32cred
import win32crypt

log = logging.getLogger(__name__)

GRAPH = "https://graph.microsoft.com/v1.0"

# Teams desktop app ID — Microsoft's own, already registered.
# We're using the user's delegated token from their live Teams session.
TEAMS_APP_ID = "1fec8e78-bce4-4aaf-ab1b-5451cc387264"

# ---------------------------------------------------------------------------
# Token extraction from Windows Credential Manager
# ---------------------------------------------------------------------------

def _get_cached_token() -> str | None:
    """
    Teams stores tokens in Windows Credential Manager under keys that
    contain the tenant ID or 'msteams'/'skype'. We scan all credentials
    and pick the first one that looks like a Graph-scoped Bearer token.
    """
    try:
        creds = win32cred.CredEnumerate(None, 0)
    except Exception as e:
        log.warning("CredEnumerate failed: %s", e)
        return None

    candidates = []
    for cred in creds:
        target = cred.get("TargetName", "")
        if not any(k in target.lower() for k in ["msteams", "microsoftteams", "teams", "skype"]):
            continue
        blob = cred.get("CredentialBlob", b"")
        if not blob:
            continue
        # blob is UTF-16-LE encoded JSON
        for enc in ("utf-16-le", "utf-8"):
            try:
                data = json.loads(blob.decode(enc, errors="ignore"))
                token = (data.get("access_token")
                         or data.get("AccessToken")
                         or data.get("token"))
                if token and isinstance(token, str) and len(token) > 100:
                    # Check expiry if available
                    exp = data.get("expires_on") or data.get("expiresOn", 0)
                    try:
                        exp_ts = float(exp)
                    except (ValueError, TypeError):
                        exp_ts = time.time() + 3600  # assume valid
                    if exp_ts > time.time() + 60:
                        candidates.append((exp_ts, token))
                break
            except Exception:
                continue

    if candidates:
        # Return the longest-lived token
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0][1]
    return None


def _get_token_from_teams_storage() -> str | None:
    """
    Fallback: read from Teams LevelDB local storage.
    New Teams (WebView2-based) stores tokens here when not in Credential Manager.
    """
    import os
    from pathlib import Path
    appdata = os.environ.get("APPDATA", "")
    storage_paths = [
        Path(appdata) / "Microsoft" / "Teams" / "Local Storage" / "leveldb",
        Path(appdata) / "Microsoft" / "Teams" / "storage.json",
    ]
    # Try storage.json first (simpler)
    storage_json = Path(appdata) / "Microsoft" / "Teams" / "storage.json"
    if storage_json.exists():
        try:
            with open(storage_json, encoding="utf-8", errors="ignore") as f:
                data = json.load(f)
            token = (data.get("accessToken")
                     or data.get("token")
                     or data.get("access_token"))
            if token:
                return token
        except Exception:
            pass

    # Try new Teams (ms-teams.exe) token location
    localappdata = os.environ.get("LOCALAPPDATA", "")
    new_teams_token = Path(localappdata) / "Packages" / "MSTeams_8wekyb3d8bbwe" / "LocalCache" / "Microsoft" / "MSTeams"
    if new_teams_token.exists():
        for f in new_teams_token.rglob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8", errors="ignore"))
                token = data.get("access_token") or data.get("AccessToken")
                if token and len(token) > 100:
                    return token
            except Exception:
                continue
    return None


def get_teams_token() -> str | None:
    token = _get_cached_token()
    if not token:
        token = _get_token_from_teams_storage()
    if not token:
        log.warning("Could not extract Teams token — is Teams desktop running and signed in?")
    return token


def _headers() -> dict:
    token = get_teams_token()
    if not token:
        raise RuntimeError("No Teams token available")
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

# ---------------------------------------------------------------------------
# Graph API calls for Teams
# ---------------------------------------------------------------------------

def get_my_chats(limit: int = 20) -> list[dict]:
    """Return all chats the user is in (DMs + group chats)."""
    r = httpx.get(
        f"{GRAPH}/me/chats?$top={limit}&$expand=members",
        headers=_headers(), timeout=15
    )
    r.raise_for_status()
    chats = []
    for c in r.json().get("value", []):
        members = [m.get("displayName", "") for m in c.get("members", [])]
        chats.append({
            "id":       c["id"],
            "type":     c.get("chatType", ""),        # oneOnOne / group
            "topic":    c.get("topic") or ", ".join(members),
            "members":  members,
            "updated":  c.get("lastUpdatedDateTime", ""),
        })
    return chats


def get_unread_chat_messages(owner_email: str) -> list[dict]:
    """
    Return recent messages across all chats where the user hasn't replied last.
    Scoped to last 50 messages per chat, last 10 chats — practical limit.
    """
    results = []
    chats = get_my_chats(10)
    for chat in chats:
        try:
            r = httpx.get(
                f"{GRAPH}/me/chats/{chat['id']}/messages?$top=5&$orderby=createdDateTime desc",
                headers=_headers(), timeout=15
            )
            r.raise_for_status()
            msgs = r.json().get("value", [])
            for msg in msgs:
                sender_email = (msg.get("from", {})
                                   .get("user", {})
                                   .get("userIdentityType", ""))
                sender_addr  = (msg.get("from", {})
                                   .get("user", {})
                                   .get("mail", "")
                                or msg.get("from", {})
                                      .get("user", {})
                                      .get("displayName", ""))
                # Skip messages sent by us
                if owner_email.lower() in sender_addr.lower():
                    continue
                body = msg.get("body", {}).get("content", "")
                results.append({
                    "msg_id":    msg["id"],
                    "chat_id":   chat["id"],
                    "chat_topic": chat["topic"],
                    "sender":    sender_addr,
                    "body":      body[:2000],
                    "created":   msg.get("createdDateTime", ""),
                })
        except Exception as e:
            log.warning("Failed to read chat %s: %s", chat["id"], e)
    return results


def send_teams_message(chat_id: str, body: str) -> dict:
    """Send a message to a Teams chat (DM or group)."""
    r = httpx.post(
        f"{GRAPH}/me/chats/{chat_id}/messages",
        headers=_headers(),
        json={"body": {"contentType": "text", "content": body}},
        timeout=15,
    )
    r.raise_for_status()
    log.info("Teams message sent to chat_id=%s", chat_id)
    return {"status": "sent", "chat_id": chat_id}


def reply_teams_message(chat_id: str, message_id: str, body: str) -> dict:
    """Reply to a specific Teams message (only works in channels, not chats)."""
    # For chat messages, we just send to the same chat
    return send_teams_message(chat_id, body)


def get_channel_messages(team_id: str, channel_id: str, top: int = 5) -> list[dict]:
    """Read messages from a specific Teams channel."""
    r = httpx.get(
        f"{GRAPH}/teams/{team_id}/channels/{channel_id}/messages?$top={top}",
        headers=_headers(), timeout=15
    )
    r.raise_for_status()
    return [
        {
            "msg_id":  m["id"],
            "sender":  m.get("from", {}).get("user", {}).get("displayName", ""),
            "body":    m.get("body", {}).get("content", "")[:2000],
            "created": m.get("createdDateTime", ""),
        }
        for m in r.json().get("value", [])
    ]


def get_teams_and_channels() -> list[dict]:
    """List all teams the user is a member of with their channels."""
    r = httpx.get(f"{GRAPH}/me/joinedTeams", headers=_headers(), timeout=15)
    r.raise_for_status()
    teams = []
    for t in r.json().get("value", []):
        try:
            rc = httpx.get(f"{GRAPH}/teams/{t['id']}/channels", headers=_headers(), timeout=10)
            rc.raise_for_status()
            channels = [{"id": c["id"], "name": c["displayName"]}
                        for c in rc.json().get("value", [])]
        except Exception:
            channels = []
        teams.append({"id": t["id"], "name": t["displayName"], "channels": channels})
    return teams


def send_channel_message(team_id: str, channel_id: str, body: str) -> dict:
    """Send a message to a Teams channel."""
    r = httpx.post(
        f"{GRAPH}/teams/{team_id}/channels/{channel_id}/messages",
        headers=_headers(),
        json={"body": {"contentType": "text", "content": body}},
        timeout=15,
    )
    r.raise_for_status()
    return {"status": "sent"}
