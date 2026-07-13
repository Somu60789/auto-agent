# register_webhooks.ps1 — Registers Microsoft Graph webhook subscriptions.
# Run once after the service is started and publicly reachable.
#
# PREREQUISITE: The Windows-Assembly EC2 must have a public HTTPS endpoint.
# Easiest: use ngrok for initial testing, then set a fixed Elastic IP + ACM cert,
# OR use AWS API Gateway as a proxy in front of localhost:8765.
#
# Usage: .\register_webhooks.ps1 -BaseUrl "https://your-public-url.com"

param(
    [Parameter(Mandatory=$true)]
    [string]$BaseUrl
)

# Load credentials from .env
$env_file = "C:\claude-delegate\.env"
Get-Content $env_file | ForEach-Object {
    if ($_ -match "^([^#][^=]+)=(.+)$") {
        [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim())
    }
}

$TENANT_ID     = $env:GRAPH_TENANT_ID
$CLIENT_ID     = $env:GRAPH_CLIENT_ID
$CLIENT_SECRET = $env:GRAPH_CLIENT_SECRET
$USER_EMAIL    = $env:GRAPH_USER_EMAIL
$WEBHOOK_SECRET = $env:WEBHOOK_SECRET

# Get token
$tokenResp = Invoke-RestMethod `
    -Uri "https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0/token" `
    -Method POST `
    -Body @{
        grant_type    = "client_credentials"
        client_id     = $CLIENT_ID
        client_secret = $CLIENT_SECRET
        scope         = "https://graph.microsoft.com/.default"
    }
$token = $tokenResp.access_token
$headers = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }

# Expiry: max 4230 minutes (~3 days) for mail; renew weekly via scheduled task
$expiry = (Get-Date).AddMinutes(4230).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

# --- Email subscription ---
$emailSub = @{
    changeType         = "created"
    notificationUrl    = "$BaseUrl/webhook/email"
    resource           = "users/$USER_EMAIL/messages"
    expirationDateTime = $expiry
    clientState        = $WEBHOOK_SECRET
} | ConvertTo-Json

Write-Host "Registering email webhook..."
$result = Invoke-RestMethod `
    -Uri "https://graph.microsoft.com/v1.0/subscriptions" `
    -Method POST -Headers $headers -Body $emailSub
Write-Host "Email subscription ID: $($result.id)"
$result.id | Out-File "C:\claude-delegate\email_sub_id.txt"

# --- Teams chat message subscription (all chats the user is in) ---
$teamsSub = @{
    changeType         = "created"
    notificationUrl    = "$BaseUrl/webhook/teams"
    resource           = "chats/getAllMessages"
    expirationDateTime = $expiry
    clientState        = $WEBHOOK_SECRET
    includeResourceData = $false
} | ConvertTo-Json

Write-Host "Registering Teams webhook..."
$result2 = Invoke-RestMethod `
    -Uri "https://graph.microsoft.com/v1.0/subscriptions" `
    -Method POST -Headers $headers -Body $teamsSub
Write-Host "Teams subscription ID: $($result2.id)"
$result2.id | Out-File "C:\claude-delegate\teams_sub_id.txt"

Write-Host ""
Write-Host "Webhooks registered. Both expire at $expiry"
Write-Host "Set up a weekly scheduled task to run: .\renew_webhooks.ps1"
