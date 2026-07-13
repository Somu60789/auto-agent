# deploy_report_v1.ps1
# Deploys report_v1.py on Windows-Assembly (i-0f14a1e74dd7aac60)
# Run via SSM Session Manager: ! aws ssm start-session --target i-0f14a1e74dd7aac60
#
# Usage:
#   .\deploy_report_v1.ps1              # full install
#   .\deploy_report_v1.ps1 -RunNow daily    # install then run daily report immediately
#   .\deploy_report_v1.ps1 -ScheduleOnly    # only register scheduled tasks, skip install

param(
    [string]$RunNow      = "",       # daily | weekly | monthly
    [switch]$ScheduleOnly = $false,
    [string]$InstallDir  = "C:\claude-delegate\reports"
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
$ScriptDir    = Split-Path -Parent $MyInvocation.MyCommand.Path
$ReportScript = Join-Path $ScriptDir "report_v1.py"
$EnvFile      = "C:\claude-delegate\.env"
$PythonVenv   = "C:\claude-delegate\venv"
$Python       = "$PythonVenv\Scripts\python.exe"
$OutputDir    = "$InstallDir\output"

# ---------------------------------------------------------------------------
# 1. Create directories
# ---------------------------------------------------------------------------
if (-not $ScheduleOnly) {
    Write-Host "[1/5] Creating directories..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $InstallDir  | Out-Null
    New-Item -ItemType Directory -Force -Path $OutputDir   | Out-Null
    New-Item -ItemType Directory -Force -Path "C:\claude-delegate\logs" | Out-Null

    # ---------------------------------------------------------------------------
    # 2. Copy report script
    # ---------------------------------------------------------------------------
    Write-Host "[2/5] Copying report_v1.py to $InstallDir..." -ForegroundColor Cyan
    Copy-Item -Force $ReportScript "$InstallDir\report_v1.py"

    # Copy shared client modules if present alongside report_v1.py
    $clients = @("jira_confluence_client.py", "github_client.py", "onedrive_client.py", "teams_client.py")
    foreach ($c in $clients) {
        $src = Join-Path $ScriptDir $c
        if (Test-Path $src) {
            Copy-Item -Force $src "$InstallDir\$c"
            Write-Host "  Copied $c" -ForegroundColor Gray
        }
    }

    # ---------------------------------------------------------------------------
    # 3. Python venv + dependencies
    # ---------------------------------------------------------------------------
    Write-Host "[3/5] Setting up Python venv at $PythonVenv..." -ForegroundColor Cyan
    if (-not (Test-Path $Python)) {
        python -m venv $PythonVenv
    }
    & $Python -m pip install --quiet --upgrade pip
    & $Python -m pip install --quiet boto3 pywin32 httpx

    # ---------------------------------------------------------------------------
    # 4. .env file (create stub if missing)
    # ---------------------------------------------------------------------------
    Write-Host "[4/5] Checking .env..." -ForegroundColor Cyan
    if (-not (Test-Path $EnvFile)) {
        Write-Host "  Creating .env stub at $EnvFile — fill in values before running." -ForegroundColor Yellow
        @"
BEDROCK_REGION=ap-south-1
BEDROCK_MODEL_ID=anthropic.claude-sonnet-4-6
OWNER_EMAIL=somasekhar.eruvuri@tatamotors.com
DAILY_UPDATE_TO=Monojit.Chakraborty@tatamotors.com,sameer.desai@tatamotors.com
DB_PATH=C:\claude-delegate\memory.db
WATCHED_REPOS=ep-infrastructure,ep-production-planning,ep-required-material,ep-production-planning-ui
GITHUB_TOKEN=
JIRA_BASE_URL=https://tatamotors.atlassian.net
ATLASSIAN_EMAIL=somasekhar.eruvuri@tatamotors.com
ATLASSIAN_API_TOKEN=
JIRA_PROJECT_KEY=DAC
GITHUB_ORG=tmlconnected
"@ | Set-Content $EnvFile
    }
}

# ---------------------------------------------------------------------------
# 5. Load .env into current session
# ---------------------------------------------------------------------------
Write-Host "[5/5] Loading .env..." -ForegroundColor Cyan
if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile) {
        if ($line -match "^\s*#" -or $line -notmatch "=") { continue }
        $parts = $line -split "=", 2
        [System.Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
    }
}

# ---------------------------------------------------------------------------
# Register Windows Scheduled Tasks
# ---------------------------------------------------------------------------
Write-Host "`n[Tasks] Registering scheduled tasks..." -ForegroundColor Cyan

function Register-ReportTask {
    param([string]$Name, [string]$Period, [string]$Schedule, [string]$DaysOfWeek = "")

    $action  = New-ScheduledTaskAction `
        -Execute $Python `
        -Argument "$InstallDir\report_v1.py $Period" `
        -WorkingDirectory $InstallDir

    $settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
        -RestartCount 2 `
        -RestartInterval (New-TimeSpan -Minutes 5)

    if ($Schedule -eq "Daily") {
        # Daily at 18:00 IST = 12:30 UTC
        $trigger = New-ScheduledTaskTrigger -Daily -At "12:30"
    } elseif ($Schedule -eq "Weekly") {
        # Every Friday at 17:00 IST = 11:30 UTC
        $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At "11:30"
    } else {
        # Monthly: last Friday approximated by running on 28th at 11:30 UTC
        # Windows doesn't have a native "last Friday" trigger — schedule on 28th and
        # let report_v1.py decide if this is the right day (it checks weekday in main agent)
        $trigger = New-ScheduledTaskTrigger -Monthly -DaysOfMonth 28 -At "11:30"
    }

    # Run as current logged-in user (needs Outlook COM)
    $principal = New-ScheduledTaskPrincipal `
        -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive `
        -RunLevel Highest

    $task = New-ScheduledTask -Action $action -Trigger $trigger `
                              -Settings $settings -Principal $principal `
                              -Description "Auto work report: $Period"

    Register-ScheduledTask -TaskName $Name -InputObject $task -Force | Out-Null
    Write-Host "  Registered: $Name" -ForegroundColor Green
}

Register-ReportTask -Name "ClaudeDelegate-DailyReport"   -Period "daily"   -Schedule "Daily"
Register-ReportTask -Name "ClaudeDelegate-WeeklyReport"  -Period "weekly"  -Schedule "Weekly"
Register-ReportTask -Name "ClaudeDelegate-MonthlyReport" -Period "monthly" -Schedule "Monthly"

# ---------------------------------------------------------------------------
# Optional: run now
# ---------------------------------------------------------------------------
if ($RunNow -ne "") {
    $period = $RunNow.ToLower()
    if ($period -notin @("daily","weekly","monthly")) {
        Write-Host "Unknown period '$RunNow'. Use daily, weekly, or monthly." -ForegroundColor Red
    } else {
        Write-Host "`nRunning $period report now..." -ForegroundColor Cyan
        & $Python "$InstallDir\report_v1.py" $period
    }
}

Write-Host "`nDone. Output reports will appear in: $OutputDir" -ForegroundColor Green
Write-Host "OneDrive folder: Reports/Daily | Reports/Weekly | Reports/Monthly" -ForegroundColor Green
