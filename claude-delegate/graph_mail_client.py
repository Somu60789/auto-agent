"""
Microsoft Graph API email client — headless, no Outlook, no Azure App Registration.
Uses MSAL public client device flow (one-time browser auth, token cached on disk).
Public client ID: Microsoft Office (well-known, no registration required).
"""

import os, json, logging, time
from pathlib import Path
import httpx

log = logging.getLogger(__name__)
GRAPH = "https://graph.microsoft.com/v1.0"
TOKEN_CACHE = Path(os.environ.get("DB_PATH", r"C:\claude-delegate\memory.db")).parent / "graph_token.json"

# Microsoft Office public client — no App Registration needed
CLIENT_ID    = "d3590ed6-52b3-4102-aeff-aad2292ab01c"
TENANT       = "organizations"
SCOPES       = ["Mail.Read", "Mail.Send", "Mail.ReadWrite"]
AUTHORITY    = f"https://login.microsoftonline.com/{TENANT}"

# ---------------------------------------------------------------------------
# Token management (MSAL with file-based cache)
# ---------------------------------------------------------------------------

def _get_msal_app():
    import msal
    cache = msal.SerializableTokenCache()
    if TOKEN_CACHE.exists():
        cache.deserialize(TOKEN_CACHE.read_text())
    app = msal.PublicClientApplication(CLIENT_ID, authority=AUTHORITY, token_cache=cache)
    return app, cache

def _save_cache(cache):
    if cache.has_state_changed:
        TOKEN_CACHE.write_text(cache.serialize())

def get_token() -> str:
    app, cache = _get_msal_app()
    accounts = app.get_accounts()
    result = None
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
    if not result or "access_token" not in result:
        # Device flow — user must open browser once
        flow = app.initiate_device_flow(scopes=SCOPES)
        if "user_code" not in flow:
            raise RuntimeError(f"Device flow failed: {flow}")
        log.warning("GRAPH AUTH REQUIRED — open browser: %s  code: %s",
                    flow["verification_uri"], flow["user_code"])
        print(f"\n>>> GRAPH AUTH: Go to {flow['verification_uri']} and enter code: {flow['user_code']}\n")
        result = app.acquire_token_by_device_flow(flow)
    if "access_token" not in result:
        raise RuntimeError(f"Token error: {result.get('error_description', result)}")
    _save_cache(cache)
    return result["access_token"]

def _h() -> dict:
    return {"Authorization": f"Bearer {get_token()}", "Content-Type": "application/json"}

# ---------------------------------------------------------------------------
# Read emails
# ---------------------------------------------------------------------------

def get_unread_emails(limit: int = 20) -> list[dict]:
    params = {
        "$filter": "isRead eq false",
        "$orderby": "receivedDateTime desc",
        "$top": limit,
        "$select": "id,subject,from,toRecipients,ccRecipients,body,receivedDateTime,conversationId",
    }
    r = httpx.get(f"{GRAPH}/me/mailFolders/inbox/messages",
                  headers=_h(), params=params, timeout=30)
    r.raise_for_status()
    results = []
    for m in r.json().get("value", []):
        results.append({
            "entry_id":        m["id"],
            "subject":         m.get("subject", ""),
            "sender":          m["from"]["emailAddress"]["address"],
            "sender_name":     m["from"]["emailAddress"].get("name", ""),
            "to":              "; ".join(r["emailAddress"]["address"] for r in m.get("toRecipients", [])),
            "cc":              "; ".join(r["emailAddress"]["address"] for r in m.get("ccRecipients", [])),
            "body":            m.get("body", {}).get("content", "")[:3000],
            "received":        m.get("receivedDateTime", ""),
            "conversation_id": m.get("conversationId", ""),
        })
    return results

def get_thread_emails(conversation_id: str, limit: int = 8) -> list[dict]:
    params = {
        "$filter": f"conversationId eq '{conversation_id}'",
        "$orderby": "receivedDateTime asc",
        "$top": limit,
        "$select": "subject,from,body,receivedDateTime",
    }
    r = httpx.get(f"{GRAPH}/me/messages", headers=_h(), params=params, timeout=30)
    r.raise_for_status()
    return [
        {
            "from":     m["from"]["emailAddress"]["address"],
            "body":     m.get("body", {}).get("content", "")[:1500],
            "received": m.get("receivedDateTime", ""),
        }
        for m in r.json().get("value", [])
    ]

# ---------------------------------------------------------------------------
# Send / reply / forward
# ---------------------------------------------------------------------------

def send_new_email(to: list[str], subject: str, body: str, cc: list[str] | None = None) -> dict:
    payload = {
        "message": {
            "subject": subject,
            "body": {"contentType": "Text", "content": body},
            "toRecipients": [{"emailAddress": {"address": a}} for a in to],
        },
        "saveToSentItems": True,
    }
    if cc:
        payload["message"]["ccRecipients"] = [{"emailAddress": {"address": a}} for a in cc]
    r = httpx.post(f"{GRAPH}/me/sendMail", headers=_h(), json=payload, timeout=30)
    r.raise_for_status()
    log.info("Graph email sent to %s subject=%s", to, subject)
    return {"status": "sent"}

def reply_email(message_id: str, body: str, reply_all: bool = False) -> dict:
    endpoint = "replyAll" if reply_all else "reply"
    r = httpx.post(f"{GRAPH}/me/messages/{message_id}/{endpoint}",
                   headers=_h(), json={"comment": body}, timeout=30)
    r.raise_for_status()
    mark_read(message_id)
    log.info("Graph reply sent message_id=%s reply_all=%s", message_id, reply_all)
    return {"status": "sent"}

def forward_email(message_id: str, to_addresses: list[str], comment: str) -> dict:
    payload = {
        "comment": comment,
        "toRecipients": [{"emailAddress": {"address": a}} for a in to_addresses],
    }
    r = httpx.post(f"{GRAPH}/me/messages/{message_id}/forward",
                   headers=_h(), json=payload, timeout=30)
    r.raise_for_status()
    mark_read(message_id)
    return {"status": "forwarded"}

def mark_read(message_id: str) -> dict:
    r = httpx.patch(f"{GRAPH}/me/messages/{message_id}",
                    headers=_h(), json={"isRead": True}, timeout=15)
    r.raise_for_status()
    return {"status": "marked_read"}

def flag_email(message_id: str, reason: str) -> dict:
    r = httpx.patch(f"{GRAPH}/me/messages/{message_id}",
                    headers=_h(),
                    json={"flag": {"flagStatus": "flagged"}, "categories": [f"Review: {reason[:40]}"]},
                    timeout=15)
    r.raise_for_status()
    return {"status": "flagged"}
