# Claude Delegate Agent — Setup Guide

Fully autonomous email + Teams agent on Windows-Assembly (i-0f14a1e74dd7aac60).

## How it works

```
Windows-Assembly (r5.xlarge, ap-south-1)
  │
  ├── Outlook desktop (COM automation via pywin32)
  │     reads unread emails, sends replies, forwards, flags
  │
  ├── agent.py (Python, Windows Service via NSSM)
  │     polls Outlook every 60s → sends to Bedrock → executes tool calls
  │
  └── Amazon Bedrock (claude-sonnet-4-6, ap-south-1)
        uses EC2 IAM role — zero API keys, zero Azure registration
```

No public endpoints. No Azure App Registration. No secrets to manage.

## Prerequisites

1. **Outlook desktop installed and signed in** on Windows-Assembly
   - Must be the full Outlook app (not Outlook Web / new Outlook)
   - Sign in with somasekhar.eruvuri@tatamotors.com — MFA handled by Outlook itself
   - Leave Outlook open — the service uses COM automation against the running process

2. **Python 3.11+** installed on Windows-Assembly
   - Download: python.org/downloads
   - During install: check "Add Python to PATH"

3. **Bedrock access** — already done (AmazonBedrockFullAccess attached to SSM_Role)

## Deploy

Connect via SSM (no RDP needed):
```powershell
aws ssm start-session --target i-0f14a1e74dd7aac60 --region ap-south-1
```

Copy files and run setup:
```powershell
# Option A: clone from repo
git clone https://github.com/tmlconnected/ep-infrastructure C:\ep-infra
Copy-Item C:\ep-infra\agents\claude-delegate\* C:\claude-delegate\ -Force

# Option B: copy manually via SSM file transfer
# Then:
cd C:\claude-delegate
.\setup_service.ps1
```

The setup script:
- Creates `C:\claude-delegate\`
- Creates Python venv + installs pywin32 + boto3
- Downloads NSSM (service manager)
- Registers `ClaudeDelegate` as a Windows Service
- Asks for your Windows password once (so the service can access Outlook COM)
- Starts the service

## Verify

```powershell
nssm status ClaudeDelegate                          # should show: SERVICE_RUNNING
Get-Content C:\claude-delegate\logs\agent.log -Wait # live log tail
Invoke-RestMethod http://localhost:8765/health       # not applicable — polling mode
```

## What the agent does

| Email type | Action |
|------------|--------|
| Technical query (infra, DR, OCI, AWS, K8s) | Reads thread → replies with precise answer |
| Meeting invite — relevant to ipms4/DR | Accepts via reply |
| Meeting invite — unrelated | Declines politely |
| Needs forwarding | Forwards to right person with context |
| FYI / status update / newsletter | Marks read |
| Security incident / AWS SIRE / legal | Flags for manual review |

## Logs and monitoring

- `C:\claude-delegate\logs\agent.log` — all actions
- `C:\claude-delegate\memory.db` — SQLite (open with DB Browser for SQLite)
- Actions table shows every reply/forward/flag with timestamp

## Restart / stop

```powershell
nssm restart ClaudeDelegate
nssm stop    ClaudeDelegate
nssm start   ClaudeDelegate
```

## Teams limitation

Teams COM automation is limited without Azure App Registration — the agent
detects Teams activity from the Teams log file but cannot send messages
programmatically. Teams replies will be logged as "pending_send" in the DB
for your manual follow-up. Full Teams automation requires either:
- Azure App Registration (Chat.ReadWrite.All) — the option we skipped
- Teams bot framework

Email automation is fully autonomous.
