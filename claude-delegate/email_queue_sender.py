"""
Email queue sender — runs as a Scheduled Task in the interactive user session.
Picks up pending emails from the SQLite queue (written by the ClaudeDelegate service)
and sends them via Outlook COM (which works in user session, not Session 0).

Scheduled Task: ClaudeDelegate-EmailSender, runs every 1 minute as the logged-in user.
"""

import os, sys, sqlite3, logging, time
from pathlib import Path

DB_PATH  = os.environ.get("DB_PATH", r"C:\claude-delegate\memory.db")
LOG_PATH = os.environ.get("LOG_PATH", r"C:\claude-delegate\logs\agent.log")

logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [email_sender] %(message)s",
)
log = logging.getLogger(__name__)


def _ensure_queue_table(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS email_queue (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            to_addr  TEXT NOT NULL,
            subject  TEXT NOT NULL,
            body     TEXT NOT NULL,
            cc       TEXT DEFAULT '',
            status   TEXT DEFAULT 'pending',
            created  TEXT DEFAULT (datetime('now')),
            sent_at  TEXT
        )
    """)
    conn.commit()


def _send_via_outlook(to_list, subject, body, cc_list=None):
    import pythoncom, win32com.client
    pythoncom.CoInitialize()
    try:
        ol   = win32com.client.Dispatch("Outlook.Application")
        mail = ol.CreateItem(0)
        mail.To      = "; ".join(to_list)
        mail.Subject = subject
        mail.Body    = body
        if cc_list:
            mail.CC = "; ".join(cc_list)
        mail.Send()
        return True
    finally:
        pythoncom.CoUninitialize()


def process_queue():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    _ensure_queue_table(conn)

    rows = conn.execute(
        "SELECT id, to_addr, subject, body, cc FROM email_queue WHERE status='pending' ORDER BY id"
    ).fetchall()

    if not rows:
        conn.close()
        return 0

    sent = 0
    for row_id, to_addr, subject, body, cc in rows:
        to_list = [a.strip() for a in to_addr.split(";") if a.strip()]
        cc_list  = [a.strip() for a in cc.split(";")  if a.strip()] if cc else None
        try:
            _send_via_outlook(to_list, subject, body, cc_list)
            conn.execute(
                "UPDATE email_queue SET status='sent', sent_at=datetime('now') WHERE id=?",
                (row_id,)
            )
            conn.commit()
            log.info("Sent queued email id=%d subject=%s to=%s", row_id, subject, to_addr)
            sent += 1
        except Exception as e:
            conn.execute(
                "UPDATE email_queue SET status='failed' WHERE id=?", (row_id,)
            )
            conn.commit()
            log.error("Failed to send queued email id=%d: %s", row_id, e)

    conn.close()
    return sent


if __name__ == "__main__":
    n = process_queue()
    if n:
        print(f"Sent {n} queued email(s)")
