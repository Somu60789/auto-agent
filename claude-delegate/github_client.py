"""
GitHub client — reads issues/PRs, posts comments, creates issues.
Auth: GitHub Personal Access Token (classic or fine-grained).
Token: github.com → Settings → Developer Settings → Personal Access Tokens
Scopes needed: repo (read + write issues, PRs, contents)
"""

import os, logging
import httpx

log = logging.getLogger(__name__)

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_ORG   = os.environ.get("GITHUB_ORG", "tmlconnected")
API          = "https://api.github.com"

def _headers() -> dict:
    if not GITHUB_TOKEN:
        raise RuntimeError("GITHUB_TOKEN not set")
    return {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

def get_my_open_prs(repo: str) -> list[dict]:
    """List open PRs in a repo assigned to or created by me."""
    r = httpx.get(f"{API}/repos/{GITHUB_ORG}/{repo}/pulls",
                  params={"state": "open", "per_page": 20},
                  headers=_headers(), timeout=15)
    r.raise_for_status()
    return [
        {
            "number":  pr["number"],
            "title":   pr["title"],
            "branch":  pr["head"]["ref"],
            "author":  pr["user"]["login"],
            "url":     pr["html_url"],
            "created": pr["created_at"],
        }
        for pr in r.json()
    ]

def get_pr_review_comments(repo: str, pr_number: int) -> list[dict]:
    """Get review comments on a PR."""
    r = httpx.get(f"{API}/repos/{GITHUB_ORG}/{repo}/pulls/{pr_number}/comments",
                  headers=_headers(), timeout=15)
    r.raise_for_status()
    return [
        {"author": c["user"]["login"], "body": c["body"][:500], "file": c.get("path", "")}
        for c in r.json()
    ]

def comment_on_pr(repo: str, pr_number: int, body: str) -> dict:
    """Post a comment on a PR or issue."""
    r = httpx.post(
        f"{API}/repos/{GITHUB_ORG}/{repo}/issues/{pr_number}/comments",
        headers=_headers(), timeout=15,
        json={"body": body}
    )
    r.raise_for_status()
    log.info("GitHub comment posted on %s#%d", repo, pr_number)
    return {"status": "commented", "repo": repo, "pr": pr_number}

def create_issue(repo: str, title: str, body: str, labels: list[str] | None = None) -> dict:
    """Create a GitHub issue."""
    payload = {"title": title, "body": body}
    if labels:
        payload["labels"] = labels
    r = httpx.post(f"{API}/repos/{GITHUB_ORG}/{repo}/issues",
                   headers=_headers(), timeout=15, json=payload)
    r.raise_for_status()
    data = r.json()
    log.info("GitHub issue created: %s#%d", repo, data["number"])
    return {"status": "created", "number": data["number"], "url": data["html_url"]}

def get_workflow_runs(repo: str, limit: int = 5) -> list[dict]:
    """Get recent GitHub Actions workflow run statuses."""
    r = httpx.get(f"{API}/repos/{GITHUB_ORG}/{repo}/actions/runs",
                  params={"per_page": limit}, headers=_headers(), timeout=15)
    r.raise_for_status()
    return [
        {
            "id":         run["id"],
            "name":       run["name"],
            "status":     run["status"],
            "conclusion": run["conclusion"],
            "branch":     run["head_branch"],
            "url":        run["html_url"],
            "created":    run["created_at"],
        }
        for run in r.json().get("workflow_runs", [])
    ]

def get_failed_workflows(repos: list[str]) -> list[dict]:
    """Check multiple repos for failed workflow runs."""
    failures = []
    for repo in repos:
        try:
            runs = get_workflow_runs(repo, limit=3)
            for run in runs:
                if run["conclusion"] == "failure":
                    failures.append({**run, "repo": repo})
        except Exception as e:
            log.warning("Failed to check workflows for %s: %s", repo, e)
    return failures
