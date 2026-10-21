# Seed only missing documents. Uses an IAM-authorized OAuth token, not the web API key.
[CmdletBinding()]
param(
    [string]$ProjectId = 'thung-rac-ch4',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function ConvertTo-FirestoreValue($Value) {
    if ($null -eq $Value) { return @{ nullValue = $null } }
    if ($Value -is [bool]) { return @{ booleanValue = $Value } }
    if ($Value -is [string]) { return @{ stringValue = $Value } }
    if ($Value -is [int] -or $Value -is [long]) { return @{ integerValue = [string]$Value } }
    if ($Value -is [double] -or $Value -is [decimal]) { return @{ doubleValue = $Value } }
    $Fields = @{}
    foreach ($Property in $Value.PSObject.Properties) {
        $Fields[$Property.Name] = ConvertTo-FirestoreValue $Property.Value
    }
    return @{ mapValue = @{ fields = $Fields } }
}

$Students = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'students.seed.json') -Encoding UTF8 -Raw | ConvertFrom-Json
$Rewards = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'rewards.seed.json') -Encoding UTF8 -Raw | ConvertFrom-Json
if ($Students.Count -ne 10) { throw 'Expected exactly 10 sample students.' }
if (@($Students.student_code | Select-Object -Unique).Count -ne $Students.Count) { throw 'Duplicate student code.' }
foreach ($Student in $Students) {
    if ($Student.student_code -notmatch '^\d{3}$' -or $Student.points_balance -ne 0) {
        throw 'Invalid sample student code or initial balance.'
    }
}
if ($ProjectId -notmatch '^[a-z][a-z0-9-]+$') { throw 'Invalid project ID.' }
$Candidates = @()
foreach ($Student in $Students) { $Candidates += @{ Path = "students/$($Student.student_code)"; Data = $Student } }
$Candidates += @{ Path = 'reward_settings/default'; Data = $Rewards }
if ($DryRun) {
    Write-Output "DRY RUN: project=$ProjectId; no network calls or writes."
    foreach ($Candidate in $Candidates) { Write-Output "Create if absent: $($Candidate.Path)" }
    exit 0
}

# Set FIRESTORE_ACCESS_TOKEN in this process, or sign in using gcloud first.
# Never print the token or store it in the repository.
$AccessToken = $env:FIRESTORE_ACCESS_TOKEN
if ([string]::IsNullOrWhiteSpace($AccessToken)) {
    if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
        throw 'Sign in with gcloud auth login, or set FIRESTORE_ACCESS_TOKEN locally. See database/README.md.'
    }
    $TokenOutput = & gcloud auth print-access-token
    if ($LASTEXITCODE -ne 0) { throw 'Cannot obtain OAuth token. Run gcloud auth login first.' }
    $AccessToken = ($TokenOutput -join '').Trim()
}
if ([string]::IsNullOrWhiteSpace($AccessToken)) { throw 'OAuth token is empty.' }
$Headers = @{ Authorization = "Bearer $AccessToken" }
$DocumentRoot = "projects/$ProjectId/databases/(default)/documents"
$BaseUri = "https://firestore.googleapis.com/v1/$DocumentRoot"
$Writes = @()
foreach ($Candidate in $Candidates) {
    try {
        $null = Invoke-RestMethod -Method Get -Uri "$BaseUri/$($Candidate.Path)" -Headers $Headers
        Write-Output "Keep existing: $($Candidate.Path)"
        continue
    } catch {
        $Response = $_.Exception.Response
        if ($null -eq $Response -or [int]$Response.StatusCode -ne 404) {
            throw "Cannot inspect $($Candidate.Path). Check IAM access, project ID and network. No commit sent. $($_.Exception.Message)"
        }
    }
    $Fields = (ConvertTo-FirestoreValue $Candidate.Data).mapValue.fields
    $Writes += @{
        update = @{ name = "$DocumentRoot/$($Candidate.Path)"; fields = $Fields }
        currentDocument = @{ exists = $false }
        updateTransforms = @(
            @{ fieldPath = 'created_at'; setToServerValue = 'REQUEST_TIME' },
            @{ fieldPath = 'updated_at'; setToServerValue = 'REQUEST_TIME' }
        )
    }
}
if ($Writes.Count -eq 0) { Write-Output 'All documents already exist. Nothing changed.'; exit 0 }
$Body = @{ writes = @($Writes) } | ConvertTo-Json -Depth 30
$null = Invoke-RestMethod -Method Post -Uri "${BaseUri}:commit" -Headers $Headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($Body))
Write-Output "Created $($Writes.Count) documents. Verifying..."
foreach ($Candidate in $Candidates) {
    $Document = Invoke-RestMethod -Method Get -Uri "$BaseUri/$($Candidate.Path)" -Headers $Headers
    if ($Document.name -ne "$DocumentRoot/$($Candidate.Path)") { throw 'Verification failed.' }
    Write-Output "Verified: $($Candidate.Path)"
}
Write-Output 'Done. No bin statistics, existing balances or point history were reset.'
