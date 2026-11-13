#Requires -Version 5.1
<#
.SYNOPSIS
    Generate the exact DO_SSH_KNOWN_HOSTS block for the OCI production host.

.DESCRIPTION
    appleboy/ssh-action pins the FIRST line of the DO_SSH_KNOWN_HOSTS secret and
    its Go SSH client offers ECDSA first. A first line that is not the ECDSA key
    makes every deploy fail with "host key fingerprint mismatch". This script
    scans one key type at a time and emits them in this exact order:
        ecdsa-sha2-nistp256, ed25519, ssh-rsa

    The secret name is kept from the DigitalOcean era by design; the values are
    now OCI host keys. Never point this script at the destroyed DigitalOcean
    droplet 139.59.249.141.

.PARAMETER TargetHost
    Production host. Defaults to the OCI host 130.210.21.100. The destroyed
    DigitalOcean address 139.59.249.141 is refused.

.PARAMETER OutFile
    Optional path to write only the known_hosts block (LF line endings).

.EXAMPLE
    .\scripts\oci\generate-known-hosts.ps1

.EXAMPLE
    .\scripts\oci\generate-known-hosts.ps1 -TargetHost 130.210.21.100 -OutFile .\known_hosts.txt
#>
[CmdletBinding()]
param(
    [string]$TargetHost = '130.210.21.100',
    [string]$OutFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

if ([string]::IsNullOrWhiteSpace($TargetHost)) {
    Fail 'host argument is empty'
}
$hostAddress = $TargetHost.Trim()
if ($hostAddress -eq '139.59.249.141') {
    Fail '139.59.249.141 is the destroyed DigitalOcean droplet; use the OCI host 130.210.21.100'
}

$sshKeyscan = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keyscan.exe'
$sshKeygen = Join-Path $env:WINDIR 'System32\OpenSSH\ssh-keygen.exe'
if (-not (Test-Path -LiteralPath $sshKeyscan)) { $sshKeyscan = 'ssh-keyscan' }
if (-not (Test-Path -LiteralPath $sshKeygen)) { $sshKeygen = 'ssh-keygen' }

if (-not (Get-Command -Name $sshKeyscan -ErrorAction SilentlyContinue)) {
    Fail 'ssh-keyscan is not available (expected Windows OpenSSH at C:\WINDOWS\System32\OpenSSH).'
}
if (-not (Get-Command -Name $sshKeygen -ErrorAction SilentlyContinue)) {
    Fail 'ssh-keygen is not available (expected Windows OpenSSH at C:\WINDOWS\System32\OpenSSH).'
}

function Get-ScanLines {
    param([Parameter(Mandatory = $true)][string]$KeyType)

    $output = @(& $sshKeyscan -T 10 -t $KeyType $hostAddress 2>$null)
    return @($output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
}

$ecdsaLines = @(Get-ScanLines -KeyType 'ecdsa')
$ed25519Lines = @(Get-ScanLines -KeyType 'ed25519')
$rsaLines = @(Get-ScanLines -KeyType 'rsa')

if ($ecdsaLines.Count -eq 0) { Fail "ssh-keyscan returned no ecdsa host key for $hostAddress" }
if ($ed25519Lines.Count -eq 0) { Fail "ssh-keyscan returned no ed25519 host key for $hostAddress" }
if ($rsaLines.Count -eq 0) { Fail "ssh-keyscan returned no RSA host key for $hostAddress" }

$lines = @($ecdsaLines + $ed25519Lines + $rsaLines)
$firstFields = @($lines[0] -split '\s+')
if ($firstFields.Count -lt 2 -or $firstFields[1] -ne 'ecdsa-sha2-nistp256') {
    $actual = if ($firstFields.Count -ge 2) { $firstFields[1] } else { 'UNKNOWN' }
    Fail "first emitted line key type is '$actual', expected ecdsa-sha2-nistp256"
}

$fingerprintFile = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllText($fingerprintFile, "$($lines[0])`n")
    $fingerprintOutput = @(& $sshKeygen -lf $fingerprintFile -E sha256 2>$null)
    if ($LASTEXITCODE -ne 0 -or $fingerprintOutput.Count -eq 0) {
        Fail 'unable to compute the first-line SHA256 fingerprint'
    }
    $match = [Regex]::Match(($fingerprintOutput -join ' '), '(?i)SHA256:[A-Za-z0-9+/=]+')
    if (-not $match.Success) {
        Fail 'ssh-keygen did not return a SHA256 fingerprint'
    }
    $fingerprint = $match.Value
}
finally {
    Remove-Item -LiteralPath $fingerprintFile -Force -ErrorAction SilentlyContinue
}

Write-Host "HOST=$hostAddress"
Write-Host "FIRST_KEY_TYPE=$($firstFields[1])"
Write-Host "FIRST_KEY_FINGERPRINT=$fingerprint"
Write-Host ''
Write-Host '----- BEGIN DO_SSH_KNOWN_HOSTS -----'
foreach ($line in $lines) { Write-Host $line }
Write-Host '----- END DO_SSH_KNOWN_HOSTS -----'
Write-Host ''

if (-not [string]::IsNullOrWhiteSpace($OutFile)) {
    $fullPath = [System.IO.Path]::GetFullPath($OutFile)
    [System.IO.File]::WriteAllText($fullPath, (($lines -join "`n") + "`n"))
    Write-Host "WROTE=$fullPath"
}

Write-Host 'Update the GitHub secret with:'
Write-Host '  gh secret set DO_SSH_KNOWN_HOSTS --repo mr3826/easymoderator < known_hosts.txt'
Write-Host 'Then record the new fingerprint receipt in scripts/oci/README.md.'
