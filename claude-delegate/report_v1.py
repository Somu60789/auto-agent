"""
Report Generator v1 — Standalone concept.

Generates Daily / Weekly / Monthly work reports for Somasekhar Eruvuri.
Can run independently (no polling agent needed) or be imported by the main agent.

Usage:
    python report_v1.py daily
    python report_v1.py weekly
    python report_v1.py monthly

Outputs:
  - HTML file saved locally to ./output/
  - Uploaded to OneDrive Reports/{Daily|Weekly|Monthly}/
  - Plain-text summary emailed to Monojit + Sameer via Outlook COM

Prerequisites on Windows-Assembly:
  - Python 3.11+ with: pip install boto3 pywin32 httpx
  - OneDrive sync client running and signed in (for Graph API token)
  - Outlook open and signed in (for COM email send)
  - .env file or environment variables set (see CONFIG section below)
  - JIRA_BASE_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN for Jira data
  - GITHUB_TOKEN for GitHub CI status
"""

import os, sys, json, sqlite3, logging, textwrap
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# CONFIG — override via environment or .env file
# ---------------------------------------------------------------------------
BEDROCK_REGION   = os.environ.get("BEDROCK_REGION", "ap-south-1")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-sonnet-4-6")
OWNER_EMAIL      = os.environ.get("OWNER_EMAIL", "somasekhar.eruvuri@tatamotors.com")
REPORT_TO        = os.environ.get("DAILY_UPDATE_TO",
                       "Monojit.Chakraborty@tatamotors.com,sameer.desai@tatamotors.com")
DB_PATH          = os.environ.get("DB_PATH", r"C:\claude-delegate\memory.db")
OUTPUT_DIR       = Path(__file__).parent / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

WATCHED_REPOS = os.environ.get("WATCHED_REPOS",
    "ep-infrastructure,ep-production-planning,ep-required-material,ep-production-planning-ui"
).split(",")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data collectors
# ---------------------------------------------------------------------------

def _get_jira_issues(limit: int = 30) -> list[dict]:
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "auto-agent" / "claude-delegate"))
        import jira_confluence_client as jcc
        return jcc.get_my_open_issues(limit)
    except Exception as e:
        log.warning("Jira unavailable: %s", e)
        return []


def _get_github_status() -> dict:
    """Returns {failures: [...], total_checked: N}"""
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "auto-agent" / "claude-delegate"))
        import github_client as ghc
        failures = ghc.get_failed_workflows(WATCHED_REPOS)
        all_runs = []
        for repo in WATCHED_REPOS:
            try:
                all_runs.extend(ghc.get_workflow_runs(repo, limit=3))
            except Exception:
                pass
        return {"failures": failures, "total_checked": len(all_runs)}
    except Exception as e:
        log.warning("GitHub unavailable: %s", e)
        return {"failures": [], "total_checked": 0}


def _get_action_log(since_days: int = 1) -> list[dict]:
    """Read action_log from agent SQLite DB."""
    try:
        since = (datetime.now(timezone.utc) - timedelta(days=since_days)).isoformat()
        conn  = sqlite3.connect(DB_PATH)
        rows  = conn.execute(
            "SELECT source, action, detail, ts FROM action_log WHERE ts >= ? ORDER BY ts DESC",
            (since,)
        ).fetchall()
        conn.close()
        return [{"source": r[0], "action": r[1], "detail": r[2], "ts": r[3]} for r in rows]
    except Exception as e:
        log.warning("DB unavailable (agent may not have run yet): %s", e)
        return []


# ---------------------------------------------------------------------------
# HTML template
# ---------------------------------------------------------------------------

def _build_html(period: str, label: str, today: str,
                jira_issues: list, gh_status: dict, actions: list) -> str:
    period_cap = period.capitalize()
    jira_rows = "\n".join(
        f"<tr><td>{i['key']}</td><td>{i['summary']}</td>"
        f"<td><span class='badge badge-{i['status'].lower().replace(' ','-')}'>{i['status']}</span></td></tr>"
        for i in jira_issues
    ) or "<tr><td colspan='3'>No open issues</td></tr>"

    fail_rows = "\n".join(
        f"<tr class='fail'><td>{f['repo']}</td><td>{f['name']}</td><td>{f['branch']}</td><td>FAILED</td></tr>"
        for f in gh_status["failures"]
    ) or "<tr class='pass'><td colspan='4'>✓ All workflows passing</td></tr>"

    action_rows = "\n".join(
        f"<tr><td>{a['ts'][11:16]}</td><td>{a['source']}</td>"
        f"<td>{a['action']}</td><td>{a['detail'][:120]}</td></tr>"
        for a in actions[:40]
    ) or "<tr><td colspan='4'>No actions logged for this period</td></tr>"

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>{period_cap} Work Report — {label}</title>
<style>
  body {{ font-family: Segoe UI, Arial, sans-serif; margin: 0; padding: 24px; background: #f5f5f5; color: #222; }}
  .card {{ background: #fff; border-radius: 8px; padding: 24px; margin-bottom: 20px;
           box-shadow: 0 2px 6px rgba(0,0,0,.08); }}
  h1 {{ color: #003087; margin-top: 0; }}
  h2 {{ color: #0060b6; font-size: 1.1rem; border-bottom: 2px solid #e0e8f0; padding-bottom: 6px; }}
  table {{ border-collapse: collapse; width: 100%; font-size: .9rem; }}
  th {{ background: #003087; color: #fff; padding: 8px 12px; text-align: left; }}
  td {{ padding: 7px 12px; border-bottom: 1px solid #eee; }}
  tr.fail {{ background: #fff0f0; }}
  tr.pass td {{ color: #1a7d3e; font-weight: 600; }}
  .badge {{ padding: 2px 8px; border-radius: 12px; font-size: .8rem; font-weight: 600; }}
  .badge-in-progress {{ background: #fff3cd; color: #856404; }}
  .badge-done {{ background: #d4edda; color: #155724; }}
  .badge-to-do {{ background: #e2e3e5; color: #383d41; }}
  .badge-blocked {{ background: #f8d7da; color: #721c24; }}
  .meta {{ color: #666; font-size: .85rem; margin-bottom: 8px; }}
  .footer {{ text-align: center; color: #999; font-size: .8rem; margin-top: 32px; }}
</style>
</head>
<body>

<div class="card">
  <h1>&#128202; {period_cap} Work Report</h1>
  <div class="meta">
    <strong>Period:</strong> {label} &nbsp;|&nbsp;
    <strong>Generated:</strong> {today} &nbsp;|&nbsp;
    <strong>Engineer:</strong> Somasekhar Eruvuri &nbsp;|&nbsp;
    <strong>Team:</strong> ipms4 / Avant Garde Platform, Tata Motors Digital
  </div>
</div>

<div class="card">
  <h2>&#128203; Open Jira Issues ({len(jira_issues)})</h2>
  <table>
    <thead><tr><th>Key</th><th>Summary</th><th>Status</th></tr></thead>
    <tbody>{jira_rows}</tbody>
  </table>
</div>

<div class="card">
  <h2>&#9881;&#65039; GitHub CI Status ({gh_status['total_checked']} runs checked)</h2>
  <table>
    <thead><tr><th>Repo</th><th>Workflow</th><th>Branch</th><th>Status</th></tr></thead>
    <tbody>{fail_rows}</tbody>
  </table>
</div>

<div class="card">
  <h2>&#128336; Agent Action Log ({len(actions)} entries)</h2>
  <table>
    <thead><tr><th>Time (UTC)</th><th>Source</th><th>Action</th><th>Detail</th></tr></thead>
    <tbody>{action_rows}</tbody>
  </table>
</div>

<div class="card">
  <h2>&#128274; Known Blockers</h2>
  <ul>
    <li><strong>DRG return route</strong> — 172.27.201.0/24 → MPLS on drg-oc3-hub.
        Oracle ACS CR pending with manoj.k.jha@oracle.com. All OC3 OKE deploys blocked until resolved.</li>
    <li><strong>HARBOR_PASSWORD</strong> — pending Harbor OC3 go-live</li>
    <li><strong>MSK bootstrap endpoint</strong> — REPLACE_MSK_BOOTSTRAP_ENDPOINT in mirrormaker2-cr.yaml</li>
  </ul>
</div>

<div class="footer">
  ipms4 / Avant Garde &mdash; OCI-OC3-AWS DR Platform &mdash; Report v1
</div>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Email via priority chain (Outlook COM → Graph API → SMTP)
# ---------------------------------------------------------------------------

def _send_email(to_list: list[str], subject: str, body_text: str):
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "auto-agent" / "claude-delegate"))
        import graph_mail_client as gmc
        result = gmc.send_email(to_list, subject, body_text)
        log.info("Report email sent via %s to %s", result.get("transport"), to_list)
    except Exception as e:
        log.error("All email transports failed: %s", e)


# ---------------------------------------------------------------------------
# OneDrive upload
# ---------------------------------------------------------------------------

def _upload_onedrive(folder_path: str, filename: str, html: str):
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "auto-agent" / "claude-delegate"))
        import onedrive_client as odc
        result = odc.upload_file(folder_path, filename, html)
        log.info("Uploaded to OneDrive: %s", result.get("url"))
        return result.get("url", "")
    except Exception as e:
        log.warning("OneDrive upload failed (will still save locally): %s", e)
        return ""


# ---------------------------------------------------------------------------
# Main report runner
# ---------------------------------------------------------------------------

def generate_report(period: str):
    """
    period: 'daily' | 'weekly' | 'monthly'
    """
    if period not in ("daily", "weekly", "monthly"):
        print(f"Usage: python report_v1.py [daily|weekly|monthly]")
        sys.exit(1)

    now   = datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")

    if period == "daily":
        label     = today
        since_days = 1
    elif period == "weekly":
        iso = now.isocalendar()
        label = f"W{iso[1]}-{iso[0]}"
        since_days = 7
    else:
        label     = now.strftime("%B-%Y")
        since_days = 31

    log.info("Generating %s report (%s)...", period, label)

    jira_issues = _get_jira_issues(30)
    gh_status   = _get_github_status()
    actions     = _get_action_log(since_days)

    html     = _build_html(period, label, today, jira_issues, gh_status, actions)
    filename = f"{period}-report-{today}.html"

    # Save locally
    local_path = OUTPUT_DIR / filename
    local_path.write_text(html, encoding="utf-8")
    log.info("Saved locally: %s", local_path)

    # Upload to OneDrive
    od_folder = f"Reports/{period.capitalize()}"
    share_url  = _upload_onedrive(od_folder, filename, html)

    # Build plain-text email body
    jira_lines = "\n".join(f"  - {i['key']}: {i['summary']} [{i['status']}]" for i in jira_issues) or "  None."
    fail_lines = "\n".join(f"  - {f['repo']}/{f['name']}: FAILED" for f in gh_status["failures"]) or "  All passing."
    share_note = f"\nOneDrive: {share_url}" if share_url else ""

    email_body = textwrap.dedent(f"""
    {period.capitalize()} Work Report — {label}
    Engineer: Somasekhar Eruvuri | Team: ipms4 Avant Garde | {today}
    {'='*60}

    JIRA OPEN ISSUES
    {jira_lines}

    GITHUB CI STATUS
    {fail_lines}

    AGENT ACTIONS ({len(actions)} logged)
    {'  ' + chr(10).join(f"  [{a['ts'][11:16]}] {a['action']}: {a['detail'][:80]}" for a in actions[:15]) or '  None.'}

    BLOCKERS
      - DRG return route pending (Oracle ACS CR — manoj.k.jha@oracle.com)
      - Harbor password pending go-live
    {share_note}
    """).strip()

    to_list = [t.strip() for t in REPORT_TO.split(",") if t.strip()]
    subject = f"{period.capitalize()} Work Report — {label} — Somasekhar Eruvuri"
    _send_email(to_list, subject, email_body)

    print(f"\n{period.capitalize()} report generated.")
    print(f"  Local:    {local_path}")
    print(f"  OneDrive: {share_url or 'upload skipped (OneDrive client not running?)'}")
    print(f"  Email:    {', '.join(to_list)}")
    return str(local_path)


if __name__ == "__main__":
    period = sys.argv[1].lower() if len(sys.argv) > 1 else "daily"
    generate_report(period)
