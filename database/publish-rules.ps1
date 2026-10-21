# Publish the reviewed prototype rules; never prints OAuth credentials.
[CmdletBinding()]
param([string]$ProjectId = 'thung-rac-ch4', [switch]$InspectOnly, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Net.ServicePointManager]::Expect100Continue = $false
if ($ProjectId -notmatch '^[a-z][a-z0-9-]+$') { throw 'Invalid project ID.' }
$Command = Get-Command gcloud.cmd -ErrorAction SilentlyContinue
$GcloudPath = if ($Command) { $Command.Source } else { 'C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd' }
$TokenOutput = & $GcloudPath auth print-access-token
if ($LASTEXITCODE -ne 0) { throw 'Run gcloud auth login first.' }
$Token = ($TokenOutput -join '').Trim()
$Headers = @{ Authorization = "Bearer $Token"; 'x-goog-user-project' = $ProjectId }
function Invoke-RulesJson([string]$Method, [string]$RequestUri, [string]$JsonBody) {
    # Pass the OAuth header through stdin, never as a command-line argument or log.
    $CurlConfig = 'header = "Authorization: Bearer ' + $Token + '"' + "`n" +
        'header = "x-goog-user-project: ' + $ProjectId + '"' + "`n" +
        'header = "Content-Type: application/json; charset=utf-8"'
    $PayloadPath = $null
    try {
        $CurlArgs = @('--config', '-', '--silent', '--show-error', '--max-time', '30', '--request', $Method, '--url', $RequestUri, '--write-out', "`n%{http_code}")
        if ($JsonBody) {
            $PayloadPath = [IO.Path]::GetTempFileName()
            [IO.File]::WriteAllText($PayloadPath, $JsonBody, (New-Object Text.UTF8Encoding($false)))
            $CurlArgs += @('--data-binary', "@$PayloadPath")
        }
        $OutputLines = @($CurlConfig | & curl.exe @CurlArgs)
        if ($LASTEXITCODE -ne 0) { throw 'Firebase Rules HTTP request failed or timed out; release not verified.' }
        $Status = [int]$OutputLines[-1]
        $ResponseBody = $OutputLines[0..($OutputLines.Count - 2)] -join "`n"
        if ($Status -lt 200 -or $Status -ge 300) { throw "Firebase Rules HTTP ${Status}: $ResponseBody" }
        return $ResponseBody | ConvertFrom-Json
    } finally {
        if ($PayloadPath) { Remove-Item -LiteralPath $PayloadPath -Force }
    }
}
$Base = 'https://firebaserules.googleapis.com/v1'
$ReleaseName = "projects/$ProjectId/releases/cloud.firestore"
Write-Output 'Reading current Firestore rules release...'
try {
    $Release = Invoke-RulesJson 'GET' "$Base/$ReleaseName"
} catch {
    if ($_.Exception.Response) {
        $Reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $Details = $Reader.ReadToEnd()
        $Reader.Dispose()
        throw "Cannot read Firebase Rules: $Details"
    }
    throw
}
$Current = Invoke-RulesJson 'GET' "$Base/$($Release.rulesetName)"
if ($InspectOnly) {
    Write-Output "Current release: $($Release.rulesetName)"
    foreach ($File in $Current.source.files) { Write-Output $File.content }
    exit 0
}
$Content = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'firestore.rules'), [Text.Encoding]::UTF8)
$Source = @{ files = @(@{ name = 'firestore.rules'; content = $Content }) }
Write-Output 'Compiling new ruleset with Firebase (not released yet)...'
$CreateBody = @{ source = $Source } | ConvertTo-Json -Depth 12
$Created = Invoke-RulesJson 'POST' "$Base/projects/$ProjectId/rulesets" $CreateBody
Write-Output "Ruleset compiled: $($Created.name)"
if ($ValidateOnly) { exit 0 }
$BackupPath = Join-Path $PSScriptRoot ("rules-backup-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
@{ release = $Release; ruleset = $Current } | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $BackupPath -Encoding UTF8
# Detect a deployment made by someone else since the initial read.
$Latest = Invoke-RulesJson 'GET' "$Base/$ReleaseName"
if ($Latest.rulesetName -ne $Release.rulesetName) { throw 'Rules changed during validation. Inspect the new rules before retrying.' }
$PatchBody = @{ release = @{ name = $ReleaseName; rulesetName = $Created.name }; updateMask = 'ruleset_name' } | ConvertTo-Json -Depth 10
Write-Output 'Publishing reviewed ruleset...'
$null = Invoke-RulesJson 'PATCH' "$Base/$ReleaseName" $PatchBody
$Verified = Invoke-RulesJson 'GET' "$Base/$ReleaseName"
if ($Verified.rulesetName -ne $Created.name) { throw 'Release verification failed.' }
Write-Output "Published and verified: $($Verified.rulesetName)"
Write-Output "Previous rules backed up: $BackupPath"
