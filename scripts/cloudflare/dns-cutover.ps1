#Requires -Version 5.1
<#
.SYNOPSIS
    EasyModerator production DNS cutover: repoint the five easymod.tech A records
    at the new Oracle Cloud public IP.

.DESCRIPTION
    This is the ONLY script allowed to mutate EasyModerator production DNS.
    It is run manually by the migration lead, never by CI.

    Scope is deliberately narrow:
      - Exactly five A records, matched by name:
            easymod.tech, www.easymod.tech, app.easymod.tech,
            api.easymod.tech, growth.easymod.tech
      - Any other record type (MX, TXT, CNAME, AAAA, CAA, SRV, ...) is never
        written. A record outside the five targets is a hard abort.
      - proxied=false and ttl=1 are invariants. Caddy owns TLS/ACME on the host,
        so a proxied (orange-cloud) record would break certificate issuance.
      - Each update is a PUT that preserves the existing record's name, proxied
        flag, TTL, comment, tags and settings; only "content" changes.

    Credentials are read ONLY from the current user's environment and are never
    accepted as parameters and never printed:
        EASYMOD_CLOUDFLARE_KEY   zone-scoped Cloudflare API token (Bearer)
        EASYMOD_CLOUDFLARE_ID    zone id (expected 249e02c98e660449093f4ef708bbbc91)

    -DryRun performs all reads and prints the planned table but issues NO
    mutation calls (no PUT/PATCH/POST/DELETE).

    After a live run the script re-reads the zone, verifies the five A values,
    verifies the non-A rows are byte-identical, and queries DNS-over-HTTPS for
    each host. Stale answers are reported, not treated as fatal - TTL is Auto
    (~300 s).

.EXAMPLE
    .\dns-cutover.ps1 -NewIP 203.0.113.10 -DryRun

.EXAMPLE
    .\dns-cutover.ps1 -NewIP 203.0.113.10
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$NewIP,

    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Constants: the blast radius is fixed here, not supplied by the caller.
# ---------------------------------------------------------------------------
$ApiBase          = 'https://api.cloudflare.com/client/v4'
$CanonicalZoneId  = '249e02c98e660449093f4ef708bbbc91'
$ExpectedZoneName = 'easymod.tech'
$TargetHosts      = @(
    'easymod.tech',
    'www.easymod.tech',
    'app.easymod.tech',
    'api.easymod.tech',
    'growth.easymod.tech'
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Fail {
    param(
        [string]$Message,
        [string]$Remediation
    )
    Write-Host "FATAL: $Message" -ForegroundColor Red
    Write-Host "REMEDIATION: $Remediation" -ForegroundColor Yellow
    exit 1
}

function Get-UserEnv {
    param([string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name, 'User')
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    return $value.Trim()
}

function Test-IPv4 {
    param([string]$Value)
    $octet = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
    if ($Value -notmatch "^$octet(\.$octet){3}$") { return $false }
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Value, [ref]$parsed)) { return $false }
    return ($parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork)
}

function Invoke-CfApi {
    param(
        [string]$Method,
        [string]$Path,
        [object]$Body,
        [string]$Remediation
    )
    $uri = "$ApiBase$Path"
    try {
        if ($null -ne $Body) {
            $json = $Body | ConvertTo-Json -Depth 10 -Compress
            return Invoke-RestMethod -Method $Method -Uri $uri -Headers $Headers `
                -ContentType 'application/json' -Body $json -ErrorAction Stop
        }
        return Invoke-RestMethod -Method $Method -Uri $uri -Headers $Headers -ErrorAction Stop
    }
    catch {
        $status = 'n/a'
        try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        Write-Host "FATAL: Cloudflare API $Method $Path failed (HTTP $status)." -ForegroundColor Red
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            Write-Host "API response: $($_.ErrorDetails.Message)"
        }
        Write-Host "REMEDIATION: $Remediation" -ForegroundColor Yellow
        exit 1
    }
}

function Get-ZoneResult {
    param([string]$ZoneId)
    try {
        $response = Invoke-RestMethod -Uri "$ApiBase/zones/$ZoneId" -Headers $Headers -Method Get -ErrorAction Stop
        return $response.result
    }
    catch {
        return $null
    }
}

function Get-AllRecords {
    $all = New-Object System.Collections.ArrayList
    $page = 1
    while ($true) {
        $response = Invoke-CfApi -Method 'Get' `
            -Path "/zones/$ZoneId/dns_records?per_page=100&page=$page" `
            -Remediation "verify EASYMOD_CLOUDFLARE_KEY is valid for zone $ZoneId and has DNS:Read. No changes were made."
        foreach ($item in @($response.result)) { [void]$all.Add($item) }
        $totalPages = 1
        $info = $response.PSObject.Properties['result_info']
        if ($info -and $null -ne $info.Value) {
            $tp = $info.Value.PSObject.Properties['total_pages']
            if ($tp -and $null -ne $tp.Value) { $totalPages = [int]$tp.Value }
        }
        if ($page -ge $totalPages -or $totalPages -eq 0) { break }
        $page++
    }
    return $all.ToArray()
}

function New-PutBody {
    param(
        [object]$Record,
        [string]$Content
    )
    $body = [ordered]@{
        type    = 'A'
        name    = $Record.name
        content = $Content
        ttl     = 1
        proxied = $false
    }
    $prop = $Record.PSObject.Properties['comment']
    if ($prop -and $null -ne $prop.Value) { $body['comment'] = $prop.Value }

    $prop = $Record.PSObject.Properties['tags']
    if ($prop -and $null -ne $prop.Value -and @($prop.Value).Count -gt 0) { $body['tags'] = @($prop.Value) }

    $prop = $Record.PSObject.Properties['settings']
    if ($prop -and $null -ne $prop.Value) {
        if (@($prop.Value.PSObject.Properties).Count -gt 0) { $body['settings'] = $prop.Value }
    }
    return $body
}

function Get-NonASignature {
    param($Records)
    $lines = @()
    $nonA = @($Records | Where-Object { $_.type -ne 'A' } | Sort-Object id)
    foreach ($record in $nonA) {
        $priority = ''
        $prop = $record.PSObject.Properties['priority']
        if ($prop -and $null -ne $prop.Value) { $priority = [string]$prop.Value }
        $lines += ("{0}|{1}|{2}|{3}|{4}|{5}" -f $record.id, $record.type, $record.name, $record.content, $priority, $record.ttl)
    }
    return ($lines -join "`n")
}

function Show-Table {
    param(
        [object[]]$Rows,
        [string]$Title
    )
    Write-Host ""
    Write-Host $Title
    Write-Host ("{0,-4} {1,-26} {2,-17} {3,-8} {4,-4} {5}" -f 'TYPE', 'NAME', 'VALUE', 'PROXIED', 'TTL', 'RECORD ID')
    foreach ($row in $Rows) {
        Write-Host ("{0,-4} {1,-26} {2,-17} {3,-8} {4,-4} {5}" -f $row.Type, $row.Name, $row.Value, $row.Proxied, $row.Ttl, $row.Id)
    }
}

function Test-DohRecord {
    param([string]$Name)
    try {
        $response = Invoke-RestMethod -Uri "https://dns.google/resolve?name=$Name&type=A" `
            -Method Get -TimeoutSec 20 -ErrorAction Stop
        $status = 'unknown'
        $prop = $response.PSObject.Properties['Status']
        if ($prop -and $null -ne $prop.Value) { $status = [string]$prop.Value }
        $answers = @()
        $prop = $response.PSObject.Properties['Answer']
        if ($prop -and $null -ne $prop.Value) {
            $answers = @($prop.Value | Where-Object { $_.type -eq 1 } |
                ForEach-Object { "$($_.data) (TTL $($_.TTL))" })
        }
        $answerText = if ($answers.Count -gt 0) { $answers -join ', ' } else { 'none' }
        Write-Host ("DoH  {0,-26} Status={1}  A: {2}" -f $Name, $status, $answerText)
    }
    catch {
        Write-Host ("DoH  {0,-26} query failed (non-fatal): {1}" -f $Name, $_.Exception.Message) -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------
Write-Host "EasyModerator DNS cutover - five A records only"
if ($DryRun) {
    Write-Host "Mode: DRY RUN - no mutation calls will be made." -ForegroundColor Cyan
} else {
    Write-Host "Mode: LIVE - the five A records will be updated." -ForegroundColor Yellow
}

if (-not (Test-IPv4 $NewIP)) {
    Fail "NewIP '$NewIP' is not a valid IPv4 address." "pass the new Oracle public IPv4 address, e.g. -NewIP 203.0.113.10. Nothing was changed."
}

$Token = Get-UserEnv 'EASYMOD_CLOUDFLARE_KEY'
if (-not $Token) {
    Fail "user environment variable EASYMOD_CLOUDFLARE_KEY is not set." "set the zone-scoped Cloudflare API token in the CURRENT USER environment (do not pass it as a parameter), open a new shell, and re-run. The token is never printed."
}

$Headers = @{ Authorization = "Bearer $Token" }

$envZoneId = Get-UserEnv 'EASYMOD_CLOUDFLARE_ID'
if (-not $envZoneId) {
    Fail "user environment variable EASYMOD_CLOUDFLARE_ID is not set." "set it to the easymod.tech zone id $CanonicalZoneId for the current user, open a new shell, and re-run."
}

$ZoneId = $null
$zone = $null
if ($envZoneId -eq $CanonicalZoneId) {
    $ZoneId = $envZoneId
    $zone = Get-ZoneResult $ZoneId
} else {
    $candidate = Get-ZoneResult $envZoneId
    if ($candidate -and $candidate.name -eq $ExpectedZoneName) {
        $ZoneId = $envZoneId
        $zone = $candidate
    } else {
        Write-Host "WARNING: EASYMOD_CLOUDFLARE_ID=$envZoneId does not resolve to $ExpectedZoneName; falling back to the canonical zone id $CanonicalZoneId." -ForegroundColor Yellow
        $ZoneId = $CanonicalZoneId
        $zone = Get-ZoneResult $ZoneId
    }
}

if (-not $zone) {
    Fail "cannot read zone $ZoneId with the supplied token." "verify EASYMOD_CLOUDFLARE_KEY is a zone-scoped token for $ExpectedZoneName ($CanonicalZoneId) with DNS:Read and DNS:Edit. No changes were made."
}
if ($zone.name -ne $ExpectedZoneName) {
    Fail "resolved zone is '$($zone.name)', expected '$ExpectedZoneName'." "stop: the credentials point at the wrong zone. Correct EASYMOD_CLOUDFLARE_ID / the token. No changes were made."
}
if ($zone.status -ne 'active') {
    Fail "zone $ExpectedZoneName status is '$($zone.status)', expected 'active'." "resolve the zone status in Cloudflare before cutover. No changes were made."
}

Write-Host "Zone: $($zone.name) ($ZoneId)"

# ---------------------------------------------------------------------------
# Read the zone and validate the blast radius
# ---------------------------------------------------------------------------
$records = @(Get-AllRecords)
Write-Host "Live records read: $($records.Count)"

$allA = @($records | Where-Object { $_.type -eq 'A' })
$unexpected = @($allA | Where-Object { $TargetHosts -notcontains $_.name })
if ($unexpected.Count -gt 0) {
    $names = ($unexpected | ForEach-Object { "$($_.name) -> $($_.content) [$($_.id)]" }) -join '; '
    Fail "unexpected A record(s) outside the five cutover targets: $names" "inspect and remove or rename the unexpected A record(s) in the Cloudflare dashboard, then re-run. This script only ever updates the five listed A records; nothing was changed."
}

$plan = New-Object System.Collections.ArrayList
$beforeRows = New-Object System.Collections.ArrayList
foreach ($fqdn in $TargetHosts) {
    $found = @($allA | Where-Object { $_.name -eq $fqdn })
    if ($found.Count -eq 0) {
        Fail "target A record $fqdn was not found." "confirm the record exists as type A in the Cloudflare dashboard. Nothing was changed."
    }
    if ($found.Count -gt 1) {
        Fail "duplicate A records found for $fqdn ($($found.Count))." "resolve the duplicate A records in the Cloudflare dashboard. Nothing was changed."
    }
    $record = $found[0]
    if ($record.proxied -ne $false) {
        Fail "$fqdn has proxied=$($record.proxied); expected DNS-only (false)." "set $fqdn to DNS only (grey cloud) in Cloudflare - Caddy owns TLS/ACME and proxying breaks it. Nothing was changed."
    }
    if ([int]$record.ttl -ne 1) {
        Fail "$fqdn has ttl=$($record.ttl); expected ttl=1 (Auto)." "restore ttl=Auto for $fqdn in Cloudflare. Nothing was changed."
    }
    [void]$plan.Add([pscustomobject]@{
        Name    = $fqdn
        Id      = $record.id
        Current = $record.content
        Record  = $record
    })
    [void]$beforeRows.Add([pscustomobject]@{
        Type    = 'A'
        Name    = $fqdn
        Value   = $record.content
        Proxied = ([string]$record.proxied).ToLower()
        Ttl     = [int]$record.ttl
        Id      = $record.id
    })
}

Show-Table -Rows $beforeRows.ToArray() -Title "BEFORE (live zone)"

Write-Host ""
Write-Host "Planned changes:"
foreach ($item in $plan) {
    if ($item.Current -eq $NewIP) {
        Write-Host ("  NO-OP   {0,-26} already {1}" -f $item.Name, $NewIP)
    } else {
        Write-Host ("  UPDATE  {0,-26} {1} -> {2}" -f $item.Name, $item.Current, $NewIP)
    }
}

if ($DryRun) {
    Write-Host ""
    Write-Host "DRY RUN complete: no PUT calls were made, no DNS data was changed." -ForegroundColor Cyan
    exit 0
}

# ---------------------------------------------------------------------------
# Live mutation: PUT one A record at a time, preserving everything but content
# ---------------------------------------------------------------------------
$nonABefore = Get-NonASignature $records
$changed = 0
foreach ($item in $plan) {
    if ($item.Current -eq $NewIP) {
        Write-Host "SKIP   $($item.Name): already $NewIP"
        continue
    }
    $body = New-PutBody -Record $item.Record -Content $NewIP
    $null = Invoke-CfApi -Method 'Put' `
        -Path "/zones/$ZoneId/dns_records/$($item.Record.id)" `
        -Body $body `
        -Remediation "the update for $($item.Name) failed after $changed record(s) may already have changed. Re-run this script (it is idempotent) to finish. There is no DNS rollback script: to roll back, re-dispatch the Release/Production workflow (protected: PRODUCTION_DEPLOY_ENABLED=true plus a DEPLOY-<sha> approval, then the environment approval) to redeploy the digest-pinned GHCR images to the OCI host. DNS A records must only ever point at the OCI production host 130.210.21.100; the old DigitalOcean droplet 139.59.249.141 was destroyed on 2026-11-13."
    Write-Host "OK     $($item.Name) -> $NewIP (id $($item.Record.id))" -ForegroundColor Green
    $changed++
}

Write-Host ""
Write-Host "Updates applied: $changed"

# ---------------------------------------------------------------------------
# Post-checks: re-read, verify A values, verify non-A rows untouched
# ---------------------------------------------------------------------------
$after = @(Get-AllRecords)
$afterRows = New-Object System.Collections.ArrayList
$afterBad = New-Object System.Collections.ArrayList
foreach ($fqdn in $TargetHosts) {
    $found = @($after | Where-Object { $_.type -eq 'A' -and $_.name -eq $fqdn })
    if ($found.Count -ne 1) {
        [void]$afterBad.Add("${fqdn}: expected exactly one A record, found $($found.Count)")
        continue
    }
    $record = $found[0]
    [void]$afterRows.Add([pscustomobject]@{
        Type    = 'A'
        Name    = $fqdn
        Value   = $record.content
        Proxied = ([string]$record.proxied).ToLower()
        Ttl     = [int]$record.ttl
        Id      = $record.id
    })
    if ($record.content -ne $NewIP) { [void]$afterBad.Add("$fqdn content is $($record.content), expected $NewIP") }
    if ($record.proxied -ne $false) { [void]$afterBad.Add("$fqdn proxied is $($record.proxied), expected false") }
    if ([int]$record.ttl -ne 1) { [void]$afterBad.Add("$fqdn ttl is $($record.ttl), expected 1") }
}

Show-Table -Rows $afterRows.ToArray() -Title "AFTER (re-read from API)"

$nonAAfter = Get-NonASignature $after
if ($nonABefore -ne $nonAAfter) {
    Write-Host "FATAL: non-A records (MX/TXT/DKIM/DMARC/Resend) changed during the run." -ForegroundColor Red
    Write-Host "REMEDIATION: stop and diff the full zone against docs/launch/cloudflare-zone-snapshot-2026-11-11.json. Only the five A records may change." -ForegroundColor Yellow
    exit 2
}
Write-Host "INVARIANT PASS: every non-A record is unchanged." -ForegroundColor Green

if ($afterBad.Count -gt 0) {
    Write-Host "FATAL: post-update verification failed:" -ForegroundColor Red
    foreach ($problem in $afterBad) { Write-Host "  - $problem" -ForegroundColor Red }
    Write-Host "REMEDIATION: inspect the zone with GET /dns_records and finish with this script. For a service rollback, re-dispatch Release/Production to the OCI host (digest-pinned GHCR images); DNS A records must only ever point at 130.210.21.100. Never point them at the destroyed DigitalOcean droplet 139.59.249.141." -ForegroundColor Yellow
    exit 2
}

# ---------------------------------------------------------------------------
# DNS-over-HTTPS propagation check (non-fatal by design)
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "DNS-over-HTTPS verification (dns.google):"
foreach ($fqdn in $TargetHosts) { Test-DohRecord $fqdn }
Write-Host ""
Write-Host "Propagation: record TTL is Auto (1) which Cloudflare serves as ~300 s."
Write-Host "dns.google or a recursive resolver may still show the old address until that TTL expires."
Write-Host "NXDOMAIN or stale answers here are NOT fatal - re-check after 5-10 minutes before rolling back."
Write-Host ""
Write-Host "Cutover API work complete. Next: run the post-cutover checks in docs/launch/dns-cutover-runbook-20261111.md." -ForegroundColor Green
exit 0