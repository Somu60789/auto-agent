"""
Jira + Confluence client — reads tickets, updates work logs, posts pages.
Uses Atlassian REST API with basic auth (email + API token).
API token: id.atlassian.net → Account Settings → Security → API tokens
"""

import os, logging
import httpx

log = logging.getLogger(__name__)

JIRA_BASE       = os.environ.get("JIRA_BASE_URL", "")       # e.g. https://tatamotors.atlassian.net
CONFLUENCE_BASE = os.environ.get("CONFLUENCE_BASE_URL", "") # same domain usually
ATLASSIAN_EMAIL = os.environ.get("ATLASSIAN_EMAIL", "somasekhar.eruvuri@tatamotors.com")
ATLASSIAN_TOKEN = os.environ.get("ATLASSIAN_API_TOKEN", "")

def _auth():
    return (ATLASSIAN_EMAIL, ATLASSIAN_TOKEN)

# ---------------------------------------------------------------------------
# Jira
# ---------------------------------------------------------------------------

def get_my_open_issues(max_results: int = 20) -> list[dict]:
    """Return open Jira issues assigned to me."""
    if not JIRA_BASE or not ATLASSIAN_TOKEN:
        return []
    jql = f'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
    r = httpx.get(
        f"{JIRA_BASE}/rest/api/3/search",
        params={"jql": jql, "maxResults": max_results,
                "fields": "summary,status,priority,updated,comment,description"},
        auth=_auth(), timeout=15
    )
    r.raise_for_status()
    issues = []
    for i in r.json().get("issues", []):
        f = i.get("fields", {})
        issues.append({
            "key":      i["key"],
            "summary":  f.get("summary", ""),
            "status":   f.get("status", {}).get("name", ""),
            "priority": f.get("priority", {}).get("name", ""),
            "updated":  f.get("updated", ""),
        })
    return issues


def add_work_log(issue_key: str, comment: str, time_spent: str = "1h") -> dict:
    """Log work on a Jira issue (e.g. time_spent='2h 30m')."""
    if not JIRA_BASE or not ATLASSIAN_TOKEN:
        return {"error": "Jira not configured"}
    r = httpx.post(
        f"{JIRA_BASE}/rest/api/3/issue/{issue_key}/worklog",
        auth=_auth(), timeout=15,
        json={
            "comment": {
                "type": "doc", "version": 1,
                "content": [{"type": "paragraph",
                             "content": [{"type": "text", "text": comment}]}]
            },
            "timeSpent": time_spent,
        }
    )
    r.raise_for_status()
    return {"status": "logged", "issue": issue_key}


def transition_issue(issue_key: str, status_name: str) -> dict:
    """Move a Jira issue to a new status (e.g. 'In Progress', 'Done')."""
    if not JIRA_BASE or not ATLASSIAN_TOKEN:
        return {"error": "Jira not configured"}
    # Get available transitions
    tr = httpx.get(f"{JIRA_BASE}/rest/api/3/issue/{issue_key}/transitions",
                   auth=_auth(), timeout=10)
    tr.raise_for_status()
    transitions = tr.json().get("transitions", [])
    match = next((t for t in transitions
                  if t["name"].lower() == status_name.lower()), None)
    if not match:
        return {"error": f"Transition '{status_name}' not found. Available: {[t['name'] for t in transitions]}"}
    r = httpx.post(
        f"{JIRA_BASE}/rest/api/3/issue/{issue_key}/transitions",
        auth=_auth(), timeout=10,
        json={"transition": {"id": match["id"]}}
    )
    r.raise_for_status()
    return {"status": "transitioned", "issue": issue_key, "to": status_name}


def add_comment(issue_key: str, comment: str) -> dict:
    """Add a comment to a Jira issue."""
    if not JIRA_BASE or not ATLASSIAN_TOKEN:
        return {"error": "Jira not configured"}
    r = httpx.post(
        f"{JIRA_BASE}/rest/api/3/issue/{issue_key}/comment",
        auth=_auth(), timeout=15,
        json={
            "body": {
                "type": "doc", "version": 1,
                "content": [{"type": "paragraph",
                             "content": [{"type": "text", "text": comment}]}]
            }
        }
    )
    r.raise_for_status()
    return {"status": "commented", "issue": issue_key}

# ---------------------------------------------------------------------------
# Confluence
# ---------------------------------------------------------------------------

def search_confluence(query: str, space_key: str = "", limit: int = 5) -> list[dict]:
    """Search Confluence pages by keyword."""
    if not CONFLUENCE_BASE or not ATLASSIAN_TOKEN:
        return []
    params = {"cql": f'text ~ "{query}" AND type = "page"', "limit": limit}
    if space_key:
        params["cql"] += f' AND space = "{space_key}"'
    r = httpx.get(f"{CONFLUENCE_BASE}/wiki/rest/api/content/search",
                  params=params, auth=_auth(), timeout=15)
    r.raise_for_status()
    return [
        {"id": p["id"], "title": p["title"],
         "url": f"{CONFLUENCE_BASE}/wiki{p['_links']['webui']}"}
        for p in r.json().get("results", [])
    ]


def get_confluence_page(page_id: str) -> dict:
    """Get full content of a Confluence page."""
    if not CONFLUENCE_BASE or not ATLASSIAN_TOKEN:
        return {}
    r = httpx.get(
        f"{CONFLUENCE_BASE}/wiki/rest/api/content/{page_id}?expand=body.storage,version",
        auth=_auth(), timeout=15
    )
    r.raise_for_status()
    data = r.json()
    return {
        "id":      data["id"],
        "title":   data["title"],
        "version": data["version"]["number"],
        "body":    data["body"]["storage"]["value"][:3000],
    }


def create_or_update_confluence_page(space_key: str, title: str,
                                     body_html: str, parent_id: str = "") -> dict:
    """Create a new Confluence page or update if title already exists in space."""
    if not CONFLUENCE_BASE or not ATLASSIAN_TOKEN:
        return {"error": "Confluence not configured"}

    # Check if page exists
    existing = search_confluence(f'title = "{title}"', space_key=space_key, limit=1)
    if existing:
        page_id = existing[0]["id"]
        page    = get_confluence_page(page_id)
        version = page["version"] + 1
        r = httpx.put(
            f"{CONFLUENCE_BASE}/wiki/rest/api/content/{page_id}",
            auth=_auth(), timeout=20,
            json={
                "version": {"number": version},
                "title":   title,
                "type":    "page",
                "body":    {"storage": {"value": body_html, "representation": "storage"}},
            }
        )
        r.raise_for_status()
        return {"status": "updated", "page_id": page_id, "title": title}

    # Create new
    payload = {
        "type":  "page",
        "title": title,
        "space": {"key": space_key},
        "body":  {"storage": {"value": body_html, "representation": "storage"}},
    }
    if parent_id:
        payload["ancestors"] = [{"id": parent_id}]
    r = httpx.post(f"{CONFLUENCE_BASE}/wiki/rest/api/content",
                   auth=_auth(), timeout=20, json=payload)
    r.raise_for_status()
    data = r.json()
    return {"status": "created", "page_id": data["id"], "title": title,
            "url": f"{CONFLUENCE_BASE}/wiki{data['_links']['webui']}"}
