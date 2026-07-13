# renew_webhooks.ps1 — Renews Graph webhook subscriptions before they expire.
# Schedule this weekly via Windows Task Scheduler.

Get-Content "C:\claude-delegate\.env" | ForEach-Object {
    if ($_ -match "^([^#][^=]+)=(.+)$") {
        [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim())
    }
}

$tokenResp = Invoke-RestMethod `
    -Uri "https://login.microsoftonline.com/$env:GRAPH_TENANT_ID/oauth2/v2.0/token" `
    -Method POST `
    -Body @{
        grant_type    = "client_credentials"
        client_id     = $env:GRAPH_CLIENT_ID
        client_secret = $env:GRAPH_CLIENT_SECRET
        scope         = "https://graph.microsoft.com/.default"
    }
$headers = @{ Authorization = "Bearer $($tokenResp.access_token)"; "Content-Type" = "application/json" }
$expiry  = (Get-Date).AddMinutes(4230).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$body    = @{ expirationDateTime = $expiry } | ConvertTo-Json

foreach ($file in @("C:\claude-delegate\email_sub_id.txt","C:\claude-delegate\teams_sub_id.txt")) {
    if (Test-Path $file) {
        $id = Get-Content $file
        Invoke-RestMethod `
            -Uri "https://graph.microsoft.com/v1.0/subscriptions/$id" `
            -Method PATCH -Headers $headers -Body $body | Out-Null
        Write-Host "Renewed subscription $id until $expiry"
    }
}
