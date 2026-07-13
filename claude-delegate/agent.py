"""
Claude Delegate Agent — fully autonomous email + Teams responder.
Runs as a Windows Service on Windows-Assembly (i-0f14a1e74dd7aac60).

Auth:    EC2 IAM role (SSM_Role + AmazonBedrockFullAccess) — zero keys needed
Email:   Outlook COM automation via pywin32 (Outlook handles M365/MFA auth)
Teams:   Teams COM automation via pywin32
LLM:     Amazon Bedrock (claude-sonnet-4-6, ap-south-1)

No Azure App Registration. No public endpoints. Pure Windows COM + IAM role.
"""

import os, json, sqlite3, logging, textwrap, time, traceback
from datetime import datetime, timezone

import boto3
import win32com.client
import pythoncom
import teams_client
import jira_confluence_client as jcc
import github_client as ghc
import onedrive_client as odc

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BEDROCK_REGION  = os.environ.get("BEDROCK_REGION", "ap-south-1")
MODEL_ID        = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-6")
DB_PATH         = os.environ.get("DB_PATH",  r"C:\claude-delegate\memory.db")
LOG_PATH        = os.environ.get("LOG_PATH", r"C:\claude-delegate\logs\agent.log")
POLL_INTERVAL        = int(os.environ.get("POLL_INTERVAL_SECONDS", "60"))
OWNER_EMAIL          = os.environ.get("OWNER_EMAIL", "somasekhar.eruvuri@tatamotors.com")
DAILY_UPDATE_HOUR    = int(os.environ.get("DAILY_UPDATE_HOUR", "18"))    # 6 PM IST
DAILY_UPDATE_TO      = os.environ.get("DAILY_UPDATE_TO",
                           "Monojit.Chakraborty@tatamotors.com,sameer.desai@tatamotors.com")
JIRA_PROJECT_KEY     = os.environ.get("JIRA_PROJECT_KEY", "DAC")
WATCHED_REPOS        = os.environ.get("WATCHED_REPOS",
                           "ep-infrastructure,ep-production-planning,ep-required-material,ep-production-planning-ui").split(",")

os.makedirs(r"C:\claude-delegate\logs", exist_ok=True)
logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)

# ---------------------------------------------------------------------------
# SQLite memory
# ---------------------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""CREATE TABLE IF NOT EXISTS processed (
        entry_id TEXT PRIMARY KEY,
        ts       TEXT
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS thread_context (
        thread_id TEXT PRIMARY KEY,
        summary   TEXT,
        updated   TEXT
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS action_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        source    TEXT,
        action    TEXT,
        detail    TEXT,
        ts        TEXT
    )""")
    conn.commit()
    return conn

def is_processed(entry_id: str) -> bool:
    with get_db() as conn:
        return conn.execute("SELECT 1 FROM processed WHERE entry_id=?", (entry_id,)).fetchone() is not None

def mark_processed(entry_id: str):
    with get_db() as conn:
        conn.execute("INSERT OR IGNORE INTO processed VALUES (?,?)",
                     (entry_id, datetime.now(timezone.utc).isoformat()))

def get_thread_context(thread_id: str) -> str:
    with get_db() as conn:
        row = conn.execute("SELECT summary FROM thread_context WHERE thread_id=?", (thread_id,)).fetchone()
    return row[0] if row else ""

def save_thread_context(thread_id: str, summary: str):
    with get_db() as conn:
        conn.execute("INSERT OR REPLACE INTO thread_context VALUES (?,?,?)",
                     (thread_id, summary, datetime.now(timezone.utc).isoformat()))

def log_action(source: str, action: str, detail: str):
    with get_db() as conn:
        conn.execute("INSERT INTO action_log(source,action,detail,ts) VALUES (?,?,?,?)",
                     (source, action, detail[:500], datetime.now(timezone.utc).isoformat()))
    log.info("action=%s source=%s detail=%s", action, source, detail[:200])

# ---------------------------------------------------------------------------
# Outlook COM helpers
# ---------------------------------------------------------------------------

def get_outlook():
    pythoncom.CoInitialize()
    return win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")

def get_unread_emails(outlook) -> list[dict]:
    inbox = outlook.GetDefaultFolder(6)  # 6 = olFolderInbox
    messages = inbox.Items
    messages.Sort("[ReceivedTime]", True)
    results = []
    for msg in messages:
        try:
            if msg.UnRead:
                results.append({
                    "entry_id":       msg.EntryID,
                    "subject":        msg.Subject or "",
                    "sender":         msg.SenderEmailAddress or "",
                    "sender_name":    msg.SenderName or "",
                    "to":             msg.To or "",
                    "cc":             msg.CC or "",
                    "body":           msg.Body[:3000] if msg.Body else "",
                    "received":       str(msg.ReceivedTime),
                    "conversation_id": msg.ConversationID or "",
                    "com_object":     msg,  # keep ref for reply/forward
                })
                if len(results) >= 20:
                    break
        except Exception:
            continue
    return results

def get_thread_emails_com(outlook, conversation_id: str, limit: int = 8) -> list[dict]:
    inbox = outlook.GetDefaultFolder(6)
    sent  = outlook.GetDefaultFolder(5)  # 5 = olFolderSentMail
    results = []
    for folder in [inbox, sent]:
        for msg in folder.Items:
            try:
                if msg.ConversationID == conversation_id:
                    results.append({
                        "from":     msg.SenderEmailAddress or "",
                        "body":     msg.Body[:1500] if msg.Body else "",
                        "received": str(msg.ReceivedTime),
                    })
            except Exception:
                continue
    results.sort(key=lambda x: x["received"])
    return results[-limit:]

def reply_email_com(msg_obj, body: str):
    reply = msg_obj.Reply()
    reply.Body = body + "\n\n" + reply.Body
    reply.Send()

def reply_all_email_com(msg_obj, body: str):
    reply = msg_obj.ReplyAll()
    reply.Body = body + "\n\n" + reply.Body
    reply.Send()

def forward_email_com(msg_obj, to_addresses: list[str], comment: str):
    fwd = msg_obj.Forward()
    fwd.To = "; ".join(to_addresses)
    fwd.Body = comment + "\n\n" + fwd.Body
    fwd.Send()

def send_new_email_com(outlook, to: list[str], subject: str, body: str, cc: list[str] | None = None):
    mail = outlook.Application.CreateItem(0)  # 0 = olMailItem
    mail.To      = "; ".join(to)
    mail.Subject = subject
    mail.Body    = body
    if cc:
        mail.CC = "; ".join(cc)
    mail.Send()

def mark_read_com(msg_obj):
    msg_obj.UnRead = False
    msg_obj.Save()

def flag_email_com(msg_obj, reason: str):
    msg_obj.FlagRequest = f"Review: {reason}"
    msg_obj.FlagStatus  = 2  # olFlagMarked
    msg_obj.Save()

# ---------------------------------------------------------------------------
# Teams COM helpers (Microsoft Teams client must be running)
# ---------------------------------------------------------------------------

def get_unread_teams_messages() -> list[dict]:
    """
    Teams doesn't expose a proper COM/OLE interface like Outlook.
    We use the Teams logs + win32com via shell automation as a fallback.
    Real approach: Teams stores recent messages in LevelDB at:
      %AppData%\Microsoft\Teams\IndexedDB\
    For enterprise: use Graph API or Teams bot (requires Azure App).
    This implementation reads from Teams notification toast history via
    Windows Shell — a zero-registration approach that works when Teams is open.
    """
    results = []
    try:
        shell = win32com.client.Dispatch("WScript.Shell")
        # Teams writes recent chats to local storage — read the last known
        # unread indicator via the notification log
        # ponytail: this is best-effort; Teams COM access is limited without Graph
        appdata = os.environ.get("APPDATA", "")
        teams_log = os.path.join(appdata, "Microsoft", "Teams", "logs.txt")
        if os.path.exists(teams_log):
            with open(teams_log, "r", encoding="utf-8", errors="ignore") as f:
                lines = f.readlines()[-200:]
            for line in lines:
                if "incoming_message" in line.lower() or "chat_message" in line.lower():
                    results.append({"raw_log": line.strip(), "source": "teams_log"})
    except Exception as e:
        log.warning("Teams COM read failed: %s", e)
    return results

def send_teams_chat(chat_id: str, body: str) -> dict:
    return teams_client.send_teams_message(chat_id, body)

def send_teams_channel(team_id: str, channel_id: str, body: str) -> dict:
    return teams_client.send_channel_message(team_id, channel_id, body)

# Jira tools
def get_my_jira_issues() -> list:
    return jcc.get_my_open_issues()

def log_jira_work(issue_key: str, comment: str, time_spent: str = "1h") -> dict:
    return jcc.add_work_log(issue_key, comment, time_spent)

def update_jira_status(issue_key: str, status_name: str) -> dict:
    return jcc.transition_issue(issue_key, status_name)

def comment_jira(issue_key: str, comment: str) -> dict:
    return jcc.add_comment(issue_key, comment)

# Confluence tools
def search_confluence(query: str, space_key: str = "") -> list:
    return jcc.search_confluence(query, space_key)

def update_confluence_page(space_key: str, title: str, body_html: str, parent_id: str = "") -> dict:
    return jcc.create_or_update_confluence_page(space_key, title, body_html, parent_id)

# GitHub tools
def get_open_prs(repo: str) -> list:
    return ghc.get_my_open_prs(repo)

def comment_pr(repo: str, pr_number: int, body: str) -> dict:
    return ghc.comment_on_pr(repo, pr_number, body)

def create_github_issue(repo: str, title: str, body: str, labels: list | None = None) -> dict:
    return ghc.create_issue(repo, title, body, labels)

def check_failed_workflows() -> list:
    return ghc.get_failed_workflows(WATCHED_REPOS)

# OneDrive tools
def upload_to_onedrive(folder_path: str, filename: str, content: str) -> dict:
    return odc.upload_file(folder_path, filename, content)

def list_onedrive(folder_path: str = "") -> list:
    return odc.list_folder(folder_path)

def download_from_onedrive(file_path: str) -> dict:
    text = odc.download_file(file_path)
    return {"content": text[:8000], "truncated": len(text) > 8000}

def search_onedrive(query: str) -> list:
    return odc.search_files(query)

def move_onedrive_file(src_path: str, dest_folder_path: str, new_name: str = "") -> dict:
    return odc.move_file(src_path, dest_folder_path, new_name or None)

def get_onedrive_share_link(item_path: str) -> dict:
    url = odc.create_share_link(item_path)
    return {"share_url": url}

def create_onedrive_folder(parent_path: str, folder_name: str) -> dict:
    return odc.create_folder(parent_path, folder_name)

# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------
# These are called by name from Claude's tool_use blocks.
# msg_store holds live COM objects keyed by entry_id (within one poll cycle).
msg_store: dict = {}
outlook_ns = None

def read_email(entry_id: str) -> dict:
    msg = msg_store.get(entry_id)
    if not msg:
        return {"error": "message not in current batch"}
    return {
        "subject":  msg["subject"],
        "from":     msg["sender"],
        "to":       msg["to"],
        "cc":       msg["cc"],
        "body":     msg["body"],
        "received": msg["received"],
        "thread_id": msg["conversation_id"],
    }

def get_thread(entry_id: str) -> list:
    msg = msg_store.get(entry_id)
    if not msg or not outlook_ns:
        return []
    return get_thread_emails_com(outlook_ns, msg["conversation_id"])

def reply_email(entry_id: str, body: str, reply_all: bool = False) -> dict:
    msg = msg_store.get(entry_id)
    if not msg:
        return {"error": "message not found"}
    if reply_all:
        reply_all_email_com(msg["com_object"], body)
    else:
        reply_email_com(msg["com_object"], body)
    mark_read_com(msg["com_object"])
    log_action(entry_id, "email_reply", body[:300])
    return {"status": "sent"}

def forward_email(entry_id: str, to_addresses: list[str], comment: str) -> dict:
    msg = msg_store.get(entry_id)
    if not msg:
        return {"error": "message not found"}
    forward_email_com(msg["com_object"], to_addresses, comment)
    mark_read_com(msg["com_object"])
    log_action(entry_id, "email_forward", f"to={to_addresses}")
    return {"status": "forwarded"}

def send_new_email(to: list[str], subject: str, body: str, cc: list[str] | None = None) -> dict:
    if not outlook_ns:
        return {"error": "outlook not connected"}
    send_new_email_com(outlook_ns, to, subject, body, cc)
    log_action("new", "email_send", f"to={to} subject={subject}")
    return {"status": "sent"}

def flag_for_review(entry_id: str, reason: str) -> dict:
    msg = msg_store.get(entry_id)
    if msg:
        flag_email_com(msg["com_object"], reason)
        mark_read_com(msg["com_object"])
    log_action(entry_id, "flagged", reason)
    return {"status": "flagged"}

def mark_read(entry_id: str) -> dict:
    msg = msg_store.get(entry_id)
    if msg:
        mark_read_com(msg["com_object"])
    log_action(entry_id, "mark_read", "")
    return {"status": "marked_read"}

TOOL_FN = {
    "read_email":            read_email,
    "get_thread":            get_thread,
    "reply_email":           reply_email,
    "forward_email":         forward_email,
    "send_new_email":        send_new_email,
    "flag_for_review":       flag_for_review,
    "mark_read":             mark_read,
    "send_teams_chat":       send_teams_chat,
    "send_teams_channel":    send_teams_channel,
    "get_my_jira_issues":    get_my_jira_issues,
    "log_jira_work":         log_jira_work,
    "update_jira_status":    update_jira_status,
    "comment_jira":          comment_jira,
    "search_confluence":     search_confluence,
    "update_confluence_page":  update_confluence_page,
    "get_open_prs":            get_open_prs,
    "comment_pr":              comment_pr,
    "create_github_issue":     create_github_issue,
    "check_failed_workflows":  check_failed_workflows,
    "upload_to_onedrive":      upload_to_onedrive,
    "list_onedrive":           list_onedrive,
    "download_from_onedrive":  download_from_onedrive,
    "search_onedrive":         search_onedrive,
    "move_onedrive_file":      move_onedrive_file,
    "get_onedrive_share_link": get_onedrive_share_link,
    "create_onedrive_folder":  create_onedrive_folder,
}

# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------
TOOLS = [
    {
        "name": "read_email",
        "description": "Read full content of an email (subject, sender, body, thread_id).",
        "input_schema": {
            "type": "object",
            "properties": {"entry_id": {"type": "string"}},
            "required": ["entry_id"],
        },
    },
    {
        "name": "get_thread",
        "description": "Get all prior emails in the same conversation thread for context.",
        "input_schema": {
            "type": "object",
            "properties": {"entry_id": {"type": "string"}},
            "required": ["entry_id"],
        },
    },
    {
        "name": "reply_email",
        "description": "Reply to an email. Set reply_all=true to include all CC recipients.",
        "input_schema": {
            "type": "object",
            "properties": {
                "entry_id":  {"type": "string"},
                "body":      {"type": "string"},
                "reply_all": {"type": "boolean", "default": False},
            },
            "required": ["entry_id", "body"],
        },
    },
    {
        "name": "forward_email",
        "description": "Forward an email to other addresses with a covering comment.",
        "input_schema": {
            "type": "object",
            "properties": {
                "entry_id":     {"type": "string"},
                "to_addresses": {"type": "array", "items": {"type": "string"}},
                "comment":      {"type": "string"},
            },
            "required": ["entry_id", "to_addresses", "comment"],
        },
    },
    {
        "name": "send_new_email",
        "description": "Compose and send a brand-new email.",
        "input_schema": {
            "type": "object",
            "properties": {
                "to":      {"type": "array", "items": {"type": "string"}},
                "subject": {"type": "string"},
                "body":    {"type": "string"},
                "cc":      {"type": "array", "items": {"type": "string"}},
            },
            "required": ["to", "subject", "body"],
        },
    },
    {
        "name": "flag_for_review",
        "description": "Flag email for manual review — use for security incidents, legal matters, sensitive escalations.",
        "input_schema": {
            "type": "object",
            "properties": {
                "entry_id": {"type": "string"},
                "reason":   {"type": "string"},
            },
            "required": ["entry_id", "reason"],
        },
    },
    {
        "name": "mark_read",
        "description": "Mark email as read without replying — for FYI/status emails needing no response.",
        "input_schema": {
            "type": "object",
            "properties": {"entry_id": {"type": "string"}},
            "required": ["entry_id"],
        },
    },
    {
        "name": "send_teams_chat",
        "description": "Send or reply to a Teams direct message or group chat.",
        "input_schema": {
            "type": "object",
            "properties": {
                "chat_id": {"type": "string"},
                "body":    {"type": "string"},
            },
            "required": ["chat_id", "body"],
        },
    },
    {
        "name": "send_teams_channel",
        "description": "Post a message to a Teams channel.",
        "input_schema": {
            "type": "object",
            "properties": {
                "team_id":    {"type": "string"},
                "channel_id": {"type": "string"},
                "body":       {"type": "string"},
            },
            "required": ["team_id", "channel_id", "body"],
        },
    },
    {
        "name": "get_my_jira_issues",
        "description": "Get all open Jira issues assigned to me.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "log_jira_work",
        "description": "Log work done on a Jira issue with time spent.",
        "input_schema": {
            "type": "object",
            "properties": {
                "issue_key":   {"type": "string"},
                "comment":     {"type": "string"},
                "time_spent":  {"type": "string", "description": "e.g. '2h 30m'"},
            },
            "required": ["issue_key", "comment"],
        },
    },
    {
        "name": "update_jira_status",
        "description": "Move a Jira issue to a new status (e.g. 'In Progress', 'Done').",
        "input_schema": {
            "type": "object",
            "properties": {
                "issue_key":   {"type": "string"},
                "status_name": {"type": "string"},
            },
            "required": ["issue_key", "status_name"],
        },
    },
    {
        "name": "comment_jira",
        "description": "Add a comment to a Jira issue.",
        "input_schema": {
            "type": "object",
            "properties": {
                "issue_key": {"type": "string"},
                "comment":   {"type": "string"},
            },
            "required": ["issue_key", "comment"],
        },
    },
    {
        "name": "search_confluence",
        "description": "Search Confluence pages by keyword.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query":      {"type": "string"},
                "space_key":  {"type": "string"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "update_confluence_page",
        "description": "Create or update a Confluence page with new content.",
        "input_schema": {
            "type": "object",
            "properties": {
                "space_key":  {"type": "string"},
                "title":      {"type": "string"},
                "body_html":  {"type": "string"},
                "parent_id":  {"type": "string"},
            },
            "required": ["space_key", "title", "body_html"],
        },
    },
    {
        "name": "get_open_prs",
        "description": "List open pull requests in a GitHub repo.",
        "input_schema": {
            "type": "object",
            "properties": {"repo": {"type": "string"}},
            "required": ["repo"],
        },
    },
    {
        "name": "comment_pr",
        "description": "Post a comment on a GitHub PR or issue.",
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":      {"type": "string"},
                "pr_number": {"type": "integer"},
                "body":      {"type": "string"},
            },
            "required": ["repo", "pr_number", "body"],
        },
    },
    {
        "name": "create_github_issue",
        "description": "Create a new GitHub issue.",
        "input_schema": {
            "type": "object",
            "properties": {
                "repo":   {"type": "string"},
                "title":  {"type": "string"},
                "body":   {"type": "string"},
                "labels": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["repo", "title", "body"],
        },
    },
    {
        "name": "check_failed_workflows",
        "description": "Check all watched repos for failed GitHub Actions workflow runs.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "upload_to_onedrive",
        "description": "Upload a file or report content to OneDrive.",
        "input_schema": {
            "type": "object",
            "properties": {
                "folder_path": {"type": "string", "description": "e.g. Reports/Weekly"},
                "filename":    {"type": "string"},
                "content":     {"type": "string"},
            },
            "required": ["folder_path", "filename", "content"],
        },
    },
    {
        "name": "list_onedrive",
        "description": "List files and folders in a OneDrive folder. Use empty string for root.",
        "input_schema": {
            "type": "object",
            "properties": {"folder_path": {"type": "string", "description": "e.g. 'Reports' or '' for root"}},
        },
    },
    {
        "name": "download_from_onedrive",
        "description": "Read a file's content from OneDrive. Returns up to 8000 chars.",
        "input_schema": {
            "type": "object",
            "properties": {"file_path": {"type": "string", "description": "e.g. 'Documents/spec.md'"}},
            "required": ["file_path"],
        },
    },
    {
        "name": "search_onedrive",
        "description": "Search OneDrive files by name or content keyword.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
    {
        "name": "move_onedrive_file",
        "description": "Move a OneDrive file to a different folder, optionally renaming it.",
        "input_schema": {
            "type": "object",
            "properties": {
                "src_path":         {"type": "string"},
                "dest_folder_path": {"type": "string"},
                "new_name":         {"type": "string"},
            },
            "required": ["src_path", "dest_folder_path"],
        },
    },
    {
        "name": "get_onedrive_share_link",
        "description": "Get a shareable (read-only, org-scoped) link for a OneDrive file.",
        "input_schema": {
            "type": "object",
            "properties": {"item_path": {"type": "string"}},
            "required": ["item_path"],
        },
    },
    {
        "name": "create_onedrive_folder",
        "description": "Create a new folder in OneDrive.",
        "input_schema": {
            "type": "object",
            "properties": {
                "parent_path":  {"type": "string", "description": "'' for root, or 'Reports' etc."},
                "folder_name":  {"type": "string"},
            },
            "required": ["parent_path", "folder_name"],
        },
    },
]

# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------
SYSTEM = textwrap.dedent(f"""
You are acting fully autonomously on behalf of Somasekhar Eruvuri
(somasekhar.eruvuri@tatamotors.com), Senior DevSecOps Engineer at Tata Motors
Digital, ipms4/Avant Garde platform team, Pune.

Read and act on every email completely on his behalf. Write as him — first
person, professional, direct, technically precise.

Rules:
- ALWAYS call read_email first, then get_thread for context before replying
- Reply to technical queries (infra, DR, DevSecOps, OCI, AWS, Kubernetes) with
  precise answers using your knowledge of the ipms4 platform
- For emails needing a response: reply_email (or reply_all if CC list is relevant)
- For emails routed to wrong person: forward_email to correct owner
- For meeting invites relevant to ipms4/DR/DevSecOps: accept via reply_email
- For meeting invites clearly unrelated: decline politely via reply_email
- For FYI / status updates / newsletters needing no response: mark_read only
- For security incidents, legal, compliance, or AWS SIRE alerts: flag_for_review
- Never share credentials, internal OCIDs, or IPs in replies outside @tatamotors.com

Ongoing context:
- OC3 DR: OKE on rack tmjsroc03 (172.27.201.0/24), DRG attachment CR pending
  with Oracle ACS (manoj.k.jha@oracle.com)
- AWS: kops EC2, RDS Multi-AZ, MSK Kafka, ECR — ap-south-1
- OCI: ap-hyderabad-1, OKE, OCI Streaming, CNPG Postgres
- GitHub: tmlconnected/ep-infrastructure bot/oc3-dr-infra-and-deploy
- Tone: formal with leadership (Ashwinkumar Gaikwad, Monojit Chakraborty),
  collaborative with peers
""").strip()

# ---------------------------------------------------------------------------
# Bedrock agentic loop
# ---------------------------------------------------------------------------

def run_agent(prompt: str, context_id: str) -> str:
    prior = get_thread_context(context_id)
    messages = []
    if prior:
        messages += [
            {"role": "user",      "content": f"[Prior context]\n{prior}"},
            {"role": "assistant", "content": "Understood."},
        ]
    messages.append({"role": "user", "content": prompt})

    for _ in range(10):
        response = bedrock.invoke_model(
            modelId=MODEL_ID,
            body=json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 4096,
                "system":    SYSTEM,
                "tools":     TOOLS,
                "messages":  messages,
            }),
            contentType="application/json",
            accept="application/json",
        )
        result = json.loads(response["body"].read())
        content       = result.get("content", [])
        stop_reason   = result.get("stop_reason", "")
        messages.append({"role": "assistant", "content": content})

        if stop_reason == "end_turn":
            final = next((b["text"] for b in content if b.get("type") == "text"), "")
            save_thread_context(context_id, final[:500])
            return final

        if stop_reason != "tool_use":
            break

        tool_results = []
        for block in content:
            if block.get("type") != "tool_use":
                continue
            fn = TOOL_FN.get(block["name"])
            try:
                res = fn(**block["input"]) if fn else {"error": f"unknown tool {block['name']}"}
            except Exception as e:
                log.error("tool=%s err=%s", block["name"], e)
                res = {"error": str(e)}
            log.info("tool=%s input=%s result=%s", block["name"], block["input"], res)
            tool_results.append({
                "type":        "tool_result",
                "tool_use_id": block["id"],
                "content":     json.dumps(res),
            })
        messages.append({"role": "user", "content": tool_results})

    return "loop exhausted"

# ---------------------------------------------------------------------------
# Main poll loop
# ---------------------------------------------------------------------------

def poll_once():
    global outlook_ns, msg_store
    pythoncom.CoInitialize()
    try:
        # --- Outlook emails ---
        outlook_ns = get_outlook()
        emails = get_unread_emails(outlook_ns)
        for email in emails:
            eid = email["entry_id"]
            if is_processed(eid):
                continue
            mark_processed(eid)
            msg_store[eid] = email
            prior = get_thread_context(email["conversation_id"])
            prompt = (
                f"New unread email entry_id={eid}.\n"
                f"Subject: {email['subject']}\n"
                f"From: {email['sender_name']} <{email['sender']}>\n"
                f"{'Prior thread context: ' + prior if prior else ''}\n\n"
                f"Read the full email, check thread history, and take the right action."
            )
            log.info("Processing email entry_id=%s subject=%s", eid, email["subject"][:80])
            try:
                run_agent(prompt, context_id=email["conversation_id"])
            except Exception as e:
                log.error("Agent error for %s: %s\n%s", eid, e, traceback.format_exc())

        # --- Teams messages ---
        try:
            teams_msgs = teams_client.get_unread_chat_messages(OWNER_EMAIL)
            for tm in teams_msgs:
                tid = f"teams-{tm['chat_id']}-{tm['msg_id']}"
                if is_processed(tid):
                    continue
                mark_processed(tid)
                prompt = (
                    f"New Teams message in chat '{tm['chat_topic']}' (chat_id={tm['chat_id']}).\n"
                    f"From: {tm['sender']}\n"
                    f"Message: {tm['body']}\n\n"
                    f"Reply to this Teams message on my behalf using send_teams_chat."
                )
                log.info("Processing Teams msg chat=%s from=%s", tm["chat_topic"], tm["sender"])
                try:
                    run_agent(prompt, context_id=f"teams-{tm['chat_id']}")
                except Exception as e:
                    log.error("Teams agent error: %s\n%s", e, traceback.format_exc())
        except Exception as e:
            log.warning("Teams poll failed (Teams may not be running): %s", e)

    except Exception as e:
        log.error("poll_once error: %s\n%s", e, traceback.format_exc())
    finally:
        msg_store = {}
        pythoncom.CoUninitialize()


def send_daily_update():
    """
    Runs at DAILY_UPDATE_HOUR (default 6 PM IST).
    Compiles today's work from Jira + action log and emails Monojit + Sameer.
    """
    log.info("Generating daily work update...")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Gather today's actions from DB
    with get_db() as conn:
        rows = conn.execute(
            "SELECT source, action, detail, ts FROM action_log WHERE ts LIKE ? ORDER BY ts",
            (f"{today}%",)
        ).fetchall()
    actions_summary = "\n".join(
        f"- [{r[3][11:16]}] {r[1]}: {r[2][:100]}" for r in rows
    ) or "No logged actions today."

    # Get open Jira issues
    try:
        issues = jcc.get_my_open_issues(10)
        jira_summary = "\n".join(
            f"- {i['key']}: {i['summary']} [{i['status']}]" for i in issues
        ) or "No open issues."
    except Exception:
        jira_summary = "Jira unavailable."

    prompt = f"""
Today is {today}. Generate a concise daily work update email to send to
Monojit Chakraborty and Sameer Desai summarising what I worked on today.

Today's logged actions:
{actions_summary}

Open Jira issues:
{jira_summary}

Format: professional email, bullet points, no fluff. Include:
- What was completed today
- What is in progress
- Any blockers
- Plan for tomorrow

Then use send_new_email to send it to:
to=["{DAILY_UPDATE_TO.split(',')[0]}", "{DAILY_UPDATE_TO.split(',')[1] if ',' in DAILY_UPDATE_TO else ''}"]
subject="Daily Work Update — {today} — Somasekhar Eruvuri"
"""
    try:
        pythoncom.CoInitialize()
        global outlook_ns
        outlook_ns = get_outlook()
        run_agent(prompt.strip(), context_id="daily-update")
        log_action("scheduler", "daily_update_sent", today)
    except Exception as e:
        log.error("Daily update failed: %s\n%s", e, traceback.format_exc())
    finally:
        pythoncom.CoUninitialize()

def send_report(period: str, label: str):
    """
    Generic report generator for daily / weekly / monthly periods.
    Compiles Jira issues, GitHub workflow status, action log, sends email
    to Monojit + Sameer and uploads HTML to OneDrive Reports/{period}/.
    """
    log.info("Generating %s report...", period)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # Action log for the period
    with get_db() as conn:
        rows = conn.execute(
            "SELECT source, action, detail, ts FROM action_log ORDER BY ts DESC LIMIT 200"
        ).fetchall()
    actions = "\n".join(f"- [{r[3][11:16]}] {r[0]} {r[1]}: {r[2][:100]}" for r in rows[:50]) or "None."

    try:
        issues    = jcc.get_my_open_issues(20)
        jira_text = "\n".join(f"- {i['key']}: {i['summary']} [{i['status']}]" for i in issues) or "None."
    except Exception:
        jira_text = "Jira unavailable."

    try:
        failures  = ghc.get_failed_workflows(WATCHED_REPOS)
        gh_text   = "\n".join(f"- {f['repo']} / {f['name']} ({f['branch']}): FAILED" for f in failures) or "All passing."
    except Exception:
        gh_text = "GitHub unavailable."

    prompt = f"""
Generate a {period} work report ({label}) for Somasekhar Eruvuri.

Jira open issues:
{jira_text}

GitHub workflow failures:
{gh_text}

Recent actions logged ({period}):
{actions}

Instructions:
1. Write a professional HTML report with sections:
   - Executive Summary (3 bullet points)
   - Completed Work
   - In Progress
   - Blockers (mention DRG route pending if still relevant)
   - GitHub CI Status
   - Plan for next {period}
2. Call upload_to_onedrive with folder_path="Reports/{period.capitalize()}", filename="{period}-report-{today}.html", content=<the HTML>
3. Call send_new_email to send a plain-text summary version to:
   to=["{DAILY_UPDATE_TO.split(',')[0].strip()}", "{(DAILY_UPDATE_TO.split(',')[1] if ',' in DAILY_UPDATE_TO else '').strip()}"]
   subject="{period.capitalize()} Work Report — {label} — Somasekhar Eruvuri"
"""
    try:
        pythoncom.CoInitialize()
        global outlook_ns
        outlook_ns = get_outlook()
        run_agent(prompt.strip(), context_id=f"{period}-report")
        log_action("scheduler", f"{period}_report_sent", today)
    except Exception as e:
        log.error("%s report failed: %s\n%s", period, e, traceback.format_exc())
    finally:
        pythoncom.CoUninitialize()


def main():
    log.info("Claude Delegate Agent starting. poll_interval=%ds model=%s", POLL_INTERVAL, MODEL_ID)
    sent = {"daily": "", "weekly": "", "monthly": ""}

    while True:
        try:
            poll_once()
        except Exception as e:
            log.error("Top-level error: %s", e)

        now_utc      = datetime.now(timezone.utc)
        # Convert to IST (UTC+5:30)
        ist_minutes  = now_utc.hour * 60 + now_utc.minute + 330
        ist_hour     = (ist_minutes // 60) % 24
        today        = now_utc.strftime("%Y-%m-%d")
        weekday      = now_utc.weekday()   # 0=Mon … 6=Sun
        day_of_month = now_utc.day

        # Daily — 6 PM IST every day
        if ist_hour == DAILY_UPDATE_HOUR and sent["daily"] != today:
            sent["daily"] = today
            try:
                send_daily_update()
            except Exception as e:
                log.error("Daily update error: %s", e)

        # Weekly — 5 PM IST every Friday
        if ist_hour == 17 and weekday == 4 and sent["weekly"] != today:
            sent["weekly"] = today
            week_label = f"W{now_utc.isocalendar()[1]}-{now_utc.year}"
            try:
                send_report("weekly", week_label)
            except Exception as e:
                log.error("Weekly report error: %s", e)

        # Monthly — 5 PM IST on the last working day (day 28+ and Friday or last day ≤31)
        if ist_hour == 17 and day_of_month >= 28 and weekday == 4 and sent["monthly"] != today:
            sent["monthly"] = today
            month_label = now_utc.strftime("%B-%Y")
            try:
                send_report("monthly", month_label)
            except Exception as e:
                log.error("Monthly report error: %s", e)

        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    main()
