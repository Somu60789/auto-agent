"""
Email client with priority chain:
  1. Outlook COM (if Outlook/M365 installed — best, no auth issues)
  2. Graph API client credentials (app-only, no CA policy issues — needs GRAPH_CLIENT_ID/SECRET/TENANT_ID)
  3. Graph API device flow (cached token — blocked by CA 53003 on unregistered devices)
  4. SMTP AUTH (if admin enables SMTP AUTH for the mailbox — needs SMTP_PASSWORD env var)
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
    # Client credentials flow — used when GRAPH_CLIENT_ID + GRAPH_CLIENT_SECRET are set
    # (App Registration with Mail application permissions — no CA policy applies)
    client_id     = os.environ.get("GRAPH_CLIENT_ID", "")
    client_secret = os.environ.get("GRAPH_CLIENT_SECRET", "")
    tenant_id     = os.environ.get("GRAPH_TENANT_ID", "")
    if client_id and client_secret and tenant_id:
        import msal
        app = msal.ConfidentialClientApplication(
            client_id,
            authority=f"https://login.microsoftonline.com/{tenant_id}",
            client_credential=client_secret,
        )
        result = app.acquire_token_for_client(
            scopes=["https://graph.microsoft.com/.default"]
        )
        if "access_token" in result:
            return result["access_token"]
        raise RuntimeError(f"Client creds token error: {result.get('error_description', result)}")

    # Delegated device flow (requires CA policy to allow)
    app, cache = _get_msal_app()
    accounts = app.get_accounts()
    result = None
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
    if not result or "access_token" not in result:
        flow = app.initiate_device_flow(scopes=SCOPES)
        if "user_code" not in flow:
            raise RuntimeError(f"Device flow failed: {flow}")
        log.warning("GRAPH AUTH REQUIRED — open browser: %s  code: %s",
                    flow["verification_uri"], flow["user_code"])
        result = app.acquire_token_by_device_flow(flow)
    if "access_token" not in result:
        raise RuntimeError(f"Token error: {result.get('error_description', result)}")
    _save_cache(cache)
    return result["access_token"]


def is_configured() -> bool:
    """Returns False if no auth is available — caller should skip email ops gracefully."""
    client_id = os.environ.get("GRAPH_CLIENT_ID", "")
    if client_id:
        return True
    try:
        import msal
        app, _ = _get_msal_app()
        return bool(app.get_accounts())
    except Exception:
        return False

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


# ---------------------------------------------------------------------------
# Unified send — tries each transport in priority order
# ---------------------------------------------------------------------------

def _send_via_outlook_com(to: list[str], subject: str, body: str, cc: list[str] | None = None) -> bool:
    """Send via Outlook COM automation (requires M365/Outlook installed)."""
    try:
        import pythoncom, win32com.client  # noqa: F401
        pythoncom.CoInitialize()
        ol = win32com.client.Dispatch("Outlook.Application")
        mail = ol.CreateItem(0)  # 0 = olMailItem
        mail.To      = "; ".join(to)
        mail.Subject = subject
        mail.Body    = body
        if cc:
            mail.CC = "; ".join(cc)
        mail.Send()
        log.info("Email sent via Outlook COM to %s", to)
        return True
    except Exception as e:
        log.debug("Outlook COM unavailable: %s", e)
        return False
    finally:
        try:
            import pythoncom
            pythoncom.CoUninitialize()
        except Exception:
            pass


def _send_via_smtp(to: list[str], subject: str, body: str, cc: list[str] | None = None) -> bool:
    """Send via SMTP AUTH (requires SMTP_PASSWORD in env and SMTP AUTH enabled for mailbox)."""
    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart

    smtp_user     = os.environ.get("OWNER_EMAIL", "")
    smtp_password = os.environ.get("SMTP_PASSWORD", "")
    smtp_host     = os.environ.get("SMTP_HOST", "smtp.office365.com")
    smtp_port     = int(os.environ.get("SMTP_PORT", "587"))

    if not smtp_password:
        return False
    try:
        msg            = MIMEMultipart()
        msg["From"]    = smtp_user
        msg["To"]      = ", ".join(to)
        msg["Subject"] = subject
        if cc:
            msg["CC"] = ", ".join(cc)
        msg.attach(MIMEText(body, "plain"))
        with smtplib.SMTP(smtp_host, smtp_port, timeout=30) as s:
            s.starttls()
            s.login(smtp_user, smtp_password)
            s.sendmail(smtp_user, to + (cc or []), msg.as_string())
        log.info("Email sent via SMTP to %s", to)
        return True
    except Exception as e:
        log.debug("SMTP send failed: %s", e)
        return False


def send_email(to: list[str], subject: str, body: str, cc: list[str] | None = None) -> dict:
    """
    Send email using the first available transport:
      1. Outlook COM (if M365 installed)
      2. Graph API (client credentials if configured, else device flow cached token)
      3. SMTP AUTH (if SMTP_PASSWORD set and SMTP AUTH enabled for mailbox)
    """
    if _send_via_outlook_com(to, subject, body, cc):
        return {"status": "sent", "transport": "outlook_com"}

    try:
        result = send_new_email(to, subject, body, cc)
        result["transport"] = "graph_api"
        return result
    except Exception as e:
        log.warning("Graph API send failed: %s", e)

    if _send_via_smtp(to, subject, body, cc):
        return {"status": "sent", "transport": "smtp"}

    raise RuntimeError("All email transports failed. Check logs for details.")
