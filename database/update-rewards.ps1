# Update only reward rates/version; preserve existing student points and history.
[CmdletBinding()]
param([string]$ProjectId = 'thung-rac-ch4')
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if ($ProjectId -notmatch '^[a-z][a-z0-9-]+$') { throw 'Invalid project ID.' }
$Settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'rewards.seed.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$Gcloud = Get-Command gcloud.cmd -ErrorAction SilentlyContinue
if (-not $Gcloud) { $Gcloud = Get-Command gcloud -ErrorAction SilentlyContinue }
$GcloudPath = if ($Gcloud) { $Gcloud.Source } else { 'C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd' }
$Token = $env:FIRESTORE_ACCESS_TOKEN
if ([string]::IsNullOrWhiteSpace($Token)) {
    if (-not (Test-Path -LiteralPath $GcloudPath)) { throw 'Install Google Cloud CLI and run gcloud auth login first.' }
    $TokenOutput = & $GcloudPath auth print-access-token
    if ($LASTEXITCODE -ne 0) { throw 'Cannot obtain OAuth token. Run gcloud auth login first.' }
    $Token = ($TokenOutput -join '').Trim()
}
if ([string]::IsNullOrWhiteSpace($Token)) { throw 'OAuth token is empty.' }
$Headers = @{ Authorization = "Bearer $Token" }
$Root = "projects/$ProjectId/databases/(default)/documents"
$Uri = "https://firestore.googleapis.com/v1/$Root"
$Current = Invoke-RestMethod -Method Get -Uri "$Uri/reward_settings/default" -Headers $Headers
$Points = @{}
foreach ($Code in @('A', 'B', 'C')) {
    $Rate = $Settings.points_by_waste_code.$Code
    if ($Rate -isnot [int] -or $Rate -lt 0) { throw "Invalid reward rate: $Code" }
    $Points[$Code] = @{ integerValue = [string]$Rate }
}
$Fields = @{
    points_by_waste_code = @{ mapValue = @{ fields = $Points } }
    version = @{ integerValue = [string]$Settings.version }
}
$Body = @{ writes = @(@{
    update = @{ name = "$Root/reward_settings/default"; fields = $Fields }
    updateMask = @{ fieldPaths = @('points_by_waste_code', 'version') }
    currentDocument = @{ updateTime = $Current.updateTime }
    updateTransforms = @(@{ fieldPath = 'updated_at'; setToServerValue = 'REQUEST_TIME' })
}) } | ConvertTo-Json -Depth 20
$null = Invoke-RestMethod -Method Post -Uri "${Uri}:commit" -Headers $Headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($Body))
$Verified = Invoke-RestMethod -Method Get -Uri "$Uri/reward_settings/default" -Headers $Headers
foreach ($Code in @('A', 'B', 'C')) {
    if ([int]$Verified.fields.points_by_waste_code.mapValue.fields.$Code.integerValue -ne $Settings.points_by_waste_code.$Code) { throw "Verification failed: $Code" }
}
if ([int]$Verified.fields.version.integerValue -ne $Settings.version) { throw 'Version verification failed.' }
Write-Output "Verified reward_settings/default: A=$($Settings.points_by_waste_code.A), B=$($Settings.points_by_waste_code.B), C=$($Settings.points_by_waste_code.C), version=$($Settings.version)."
Write-Output 'Existing student balances, history and other settings were preserved.'
