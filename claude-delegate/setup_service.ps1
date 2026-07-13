# setup_service.ps1 — Run once on Windows-Assembly as Administrator.
# Installs Python deps, downloads NSSM, registers Claude Delegate as a Windows Service.
# No Azure App Registration needed — uses Outlook COM + EC2 IAM role for Bedrock.
#
# Usage: .\setup_service.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$INSTALL_DIR  = "C:\claude-delegate"
$VENV_DIR     = "$INSTALL_DIR\venv"
$AGENT_SCRIPT = "$INSTALL_DIR\agent.py"
$ENV_FILE     = "$INSTALL_DIR\.env"
$NSSM         = "$INSTALL_DIR\nssm.exe"
$SERVICE_NAME = "ClaudeDelegate"

# 1. Create dirs
New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null
New-Item -ItemType Directory -Force -Path "$INSTALL_DIR\logs" | Out-Null

# 2. Copy agent files
Copy-Item -Force agent.py          $AGENT_SCRIPT
Copy-Item -Force requirements.txt  "$INSTALL_DIR\requirements.txt"

# 3. Venv + deps
Write-Host "Installing Python dependencies..."
python -m venv $VENV_DIR
& "$VENV_DIR\Scripts\pip.exe" install -r "$INSTALL_DIR\requirements.txt" --quiet
# pywin32 post-install step (registers COM extensions)
& "$VENV_DIR\Scripts\python.exe" "$VENV_DIR\Scripts\pywin32_postinstall.py" -install 2>$null

# 4. Download NSSM
if (-not (Test-Path $NSSM)) {
    Write-Host "Downloading NSSM..."
    $nssmZip = "$env:TEMP\nssm.zip"
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $nssmZip
    Expand-Archive -Path $nssmZip -DestinationPath "$env:TEMP\nssm-extract" -Force
    Copy-Item "$env:TEMP\nssm-extract\nssm-2.24\win64\nssm.exe" $NSSM
}

# 5. Create .env (only non-sensitive config — no secrets needed, Bedrock uses IAM role)
if (-not (Test-Path $ENV_FILE)) {
    @"
BEDROCK_REGION=ap-south-1
BEDROCK_MODEL_ID=anthropic.claude-sonnet-4-6
OWNER_EMAIL=somasekhar.eruvuri@tatamotors.com
POLL_INTERVAL_SECONDS=60
DAILY_UPDATE_HOUR=18
DAILY_UPDATE_TO=Monojit.Chakraborty@tatamotors.com,sameer.desai@tatamotors.com
DB_PATH=C:\claude-delegate\memory.db
LOG_PATH=C:\claude-delegate\logs\agent.log

# Jira + Confluence (Atlassian Cloud)
JIRA_BASE_URL=https://tatamotors.atlassian.net
CONFLUENCE_BASE_URL=https://tatamotors.atlassian.net
ATLASSIAN_EMAIL=somasekhar.eruvuri@tatamotors.com
ATLASSIAN_API_TOKEN=REPLACE_WITH_ATLASSIAN_API_TOKEN
JIRA_PROJECT_KEY=DAC
"@ | Out-File -Encoding utf8 $ENV_FILE
    Write-Host "Config written to $ENV_FILE — edit OWNER_EMAIL if needed."
}

# 6. Register Windows Service
# IMPORTANT: Must run as the user who has Outlook open (not SYSTEM).
# Get current logged-in username for the service account.
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
Write-Host "Registering service to run as: $currentUser"

$python = "$VENV_DIR\Scripts\python.exe"
& $NSSM install $SERVICE_NAME $python $AGENT_SCRIPT
& $NSSM set $SERVICE_NAME AppDirectory   $INSTALL_DIR
& $NSSM set $SERVICE_NAME DisplayName    "Claude Delegate Agent"
& $NSSM set $SERVICE_NAME Description    "Autonomous email + Teams responder — Bedrock + Outlook COM"
& $NSSM set $SERVICE_NAME Start          SERVICE_AUTO_START
& $NSSM set $SERVICE_NAME AppStdout      "$INSTALL_DIR\logs\stdout.log"
& $NSSM set $SERVICE_NAME AppStderr      "$INSTALL_DIR\logs\stderr.log"
& $NSSM set $SERVICE_NAME AppRotateFiles 1
& $NSSM set $SERVICE_NAME AppRotateBytes 10485760

# Load env vars into service
Get-Content $ENV_FILE | ForEach-Object {
    if ($_ -match "^([^#\s][^=]+)=(.+)$") {
        & $NSSM set $SERVICE_NAME AppEnvironmentExtra "$($matches[1].Trim())=$($matches[2].Trim())"
    }
}

# Service must run as the interactive user (not SYSTEM) so Outlook COM works
$cred = Get-Credential -Message "Enter password for $currentUser (service account for Outlook COM access)"
& $NSSM set $SERVICE_NAME ObjectName $currentUser $cred.GetNetworkCredential().Password

Write-Host ""
Write-Host "Done. Starting service..."
& $NSSM start $SERVICE_NAME
Write-Host ""
Write-Host "Check status:  nssm status $SERVICE_NAME"
Write-Host "View logs:     Get-Content C:\claude-delegate\logs\agent.log -Wait"
Write-Host ""
Write-Host "PREREQUISITE: Outlook must be open and signed in on this machine."
Write-Host "The agent polls every 60 seconds for unread emails."
