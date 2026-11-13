#requires -Version 5.1

<################################################################################
  EasyModerator recovery SSH setup and validation helper

  This script is intentionally interactive and fail-closed. It does not connect
  to the host until the user has manually installed the displayed public key and
  confirmed the host-key fingerprint against ssh-keyscan output.

  It never prints private keys, secret values, .env.prod contents, or raw SSH
  output. It never deploys, restarts, mutates Docker/database state, restores,
  changes DNS, or switches traffic.

  IMPORTANT: the DigitalOcean production droplet (139.59.249.141) was DESTROYED
  on 2026-11-13. This script now targets the Oracle Cloud OCI production host
  only and refuses to run against the retired DigitalOcean address.
#################################################################################>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$ProductionHost
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProductionHost) -or $ProductionHost.Trim() -eq '139.59.249.141') {
    throw 'FATAL: -ProductionHost must be the live OCI production host (for example 130.210.21.100). Empty values and the destroyed DigitalOcean IP 139.59.249.141 are refused. No SSH, secret update, or production mutation was attempted.'
}
$script:ConfirmedProductionHost = $ProductionHost.Trim()

$script:ExitCode = 0
$script:Report = [ordered]@{
    LOCAL_KEY_EXISTS = 'NO'
    PUBLIC_KEY_FINGERPRINT = 'NOT_AVAILABLE'
    HOST_KEY_VERIFICATION = 'NOT_RUN'
    SSH_AUTH = 'NOT_RUN'
    REMOTE_HOST = 'NOT_RUN'
    REMOTE_USER = 'NOT_RUN'
    DEPLOY_PATH = 'NOT_RUN'
    ENV_FILE = 'NOT_RUN'
    BACKUP_DIR = 'NOT_RUN'
    DO_SSH_PRIVATE_KEY_GITHUB = 'NOT_CHECKED'
    DO_SSH_KNOWN_HOSTS_GITHUB = 'NOT_CHECKED'
    DEPLOY_HOST_GITHUB = 'NOT_CHECKED'
    WORKFLOW_SSH_USER_CONTRACT = 'NOT_CHECKED'
    DATABASE_BACKUP_FOUND = 'NOT_RUN'
    DATABASE_BACKUP_CUSTOM_FORMAT = 'NOT_RUN'
    DATABASE_BACKUP_SHA256 = 'NOT_RUN'
    MEDIA_BACKUP_FOUND = 'NOT_RUN'
    MEDIA_BACKUP_GZIP = 'NOT_RUN'
    MEDIA_BACKUP_ARCHIVE = 'NOT_RUN'
    MEDIA_BACKUP_SHA256 = 'NOT_RUN'
    BACKUP_TOTAL_SIZE = 'NOT_RUN'
    ROOT_DISK_USAGE = 'NOT_RUN'
    SPACES_CONFIGURATION_REQUIRED = 'NOT_CHECKED'
    SPACES_ACCESS_KEY_GITHUB = 'NOT_CHECKED'
    SPACES_SECRET_KEY_GITHUB = 'NOT_CHECKED'
    SPACES_BUCKET_CONFIGURED = 'NOT_CHECKED'
    SPACES_REGION_CONFIGURED = 'NOT_CHECKED'
    OCI_AUDIT_PRIVATE_KEY_GITHUB = 'NOT_CHECKED'
    OCI_AUDIT_TENANCY_OCID_VARIABLE = 'NOT_CHECKED'
    OCI_AUDIT_USER_OCID_VARIABLE = 'NOT_CHECKED'
    OCI_AUDIT_FINGERPRINT_VARIABLE = 'NOT_CHECKED'
    OCI_AUDIT_NAMESPACE_VARIABLE = 'NOT_CHECKED'
    OCI_AUDIT_REGION_VARIABLE = 'NOT_CHECKED'
    NEXT_BLOCKER = 'NONE'
}

$script:RepoName = 'mr3826/easymoderator'
$script:ProductionHost = $script:ConfirmedProductionHost
$script:ProductionUser = 'root'
$script:ProductionPath = '/opt/easymod'
$script:KeyComment = 'github-actions:easymoderator'
$script:UserProfile = [Environment]::GetFolderPath('UserProfile')
if ([string]::IsNullOrWhiteSpace($script:UserProfile)) {
    $script:UserProfile = $env:USERPROFILE
}
$script:PrivateKeyPath = Join-Path $script:UserProfile '.ssh\easymod-github-actions'
$script:PublicKeyPath = "$($script:PrivateKeyPath).pub"
$script:KnownHostsPath = Join-Path $env:TEMP 'easymod_known_hosts'
$script:DefaultRepoPath = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$script:RepoPath = $null
$script:PublicKey = $null
$script:SecretNames = $null
$script:RequiredSpaceNames = @()
$script:OffsiteSecretNames = @(
    'BACKUP_ENCRYPTION_KEY',
    'SPACES_ACCESS_KEY_ID',
    'SPACES_SECRET_ACCESS_KEY',
    'SPACES_ENDPOINT',
    'BACKUP_BUCKET'
)
$script:OciAuditSecretNames = @('OCI_AUDIT_PRIVATE_KEY')
$script:OciAuditVariableNames = @(
    'OCI_AUDIT_TENANCY_OCID',
    'OCI_AUDIT_USER_OCID',
    'OCI_AUDIT_FINGERPRINT',
    'OCI_AUDIT_NAMESPACE',
    'OCI_AUDIT_REGION'
)

function Write-Section {
    param([Parameter(Mandatory = $true)][string]$Title)
    Write-Host ''
    Write-Host "=== $Title ===" -ForegroundColor Cyan
}

function Add-Blocker {
    param([Parameter(Mandatory = $true)][string]$Reason)

    if ([string]::IsNullOrWhiteSpace($script:Report.NEXT_BLOCKER) -or $script:Report.NEXT_BLOCKER -eq 'NONE') {
        $script:Report.NEXT_BLOCKER = $Reason
        return
    }

    if ($script:Report.NEXT_BLOCKER -notlike "*$Reason*") {
        $script:Report.NEXT_BLOCKER = "$($script:Report.NEXT_BLOCKER); $Reason"
    }
}

function Stop-Safely {
    param([Parameter(Mandatory = $true)][string]$Reason)

    Add-Blocker -Reason $Reason
    throw (New-Object -TypeName System.OperationCanceledException -ArgumentList $Reason)
}

function Read-YesNo {
    param([Parameter(Mandatory = $true)][string]$Prompt)

    while ($true) {
        $answer = (Read-Host $Prompt).Trim().ToUpperInvariant()
        if ($answer -in @('Y', 'YES')) { return $true }
        if ($answer -in @('N', 'NO')) { return $false }
        Write-Host 'Please answer Y or N.' -ForegroundColor Yellow
    }
}

function Assert-CommandAvailable {
    param([Parameter(Mandatory = $true)][string[]]$Names)

    foreach ($name in $Names) {
        if (-not (Get-Command -Name $name -ErrorAction SilentlyContinue)) {
            Stop-Safely -Reason "Required command is missing: $name"
        }
        Write-Host "$name=AVAILABLE"
    }
}

function Get-Sha256Fingerprint {
    param([Parameter(Mandatory = $true)][string]$Path)

    $output = @(& ssh-keygen -lf $Path -E sha256 2>$null)
    if ($LASTEXITCODE -ne 0 -or $output.Count -eq 0) {
        return $null
    }

    $match = [Regex]::Match(($output -join ' '), '(?i)SHA256:[A-Za-z0-9+/=]+')
    if (-not $match.Success) {
        return $null
    }
    return $match.Value
}

function Normalize-Fingerprint {
    param([AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }

    $match = [Regex]::Match($Value.Trim(), '(?i)SHA256:[A-Za-z0-9+/=]+')
    if (-not $match.Success) {
        return $null
    }
    return $match.Value.ToUpperInvariant()
}

function Initialize-Key {
    Write-Section 'LOCAL SSH KEY PREFLIGHT'

    $privateExists = Test-Path -LiteralPath $script:PrivateKeyPath -PathType Leaf
    $publicExists = Test-Path -LiteralPath $script:PublicKeyPath -PathType Leaf

    if (-not $privateExists -and -not $publicExists) {
        $create = Read-YesNo -Prompt 'Dedicated GitHub Actions SSH key not found. Create it now? [Y/N]'
        if (-not $create) {
            Stop-Safely -Reason 'Dedicated SSH key was not created.'
        }

        $keyDirectory = Split-Path -Parent $script:PrivateKeyPath
        New-Item -ItemType Directory -Path $keyDirectory -Force | Out-Null

        $null = & ssh-keygen -t ed25519 -C $script:KeyComment -N '' -f $script:PrivateKeyPath 2>&1
        if ($LASTEXITCODE -ne 0) {
            Stop-Safely -Reason 'ssh-keygen failed while creating the dedicated key.'
        }
        $privateExists = $true
        $publicExists = $true
    }

    if (-not $privateExists -or -not $publicExists) {
        Stop-Safely -Reason 'The dedicated private/public key pair is incomplete; refusing to overwrite either file.'
    }

    $publicKey = (Get-Content -LiteralPath $script:PublicKeyPath -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($publicKey) -or $publicKey -match '[\r\n]' -or $publicKey -notmatch '^ssh-ed25519\s+\S+(\s+.*)?$') {
        Stop-Safely -Reason 'The expected public key file is missing or is not an ed25519 public key.'
    }
    if ($publicKey.Contains("'")) {
        Stop-Safely -Reason 'The public key contains an unsupported quote; refusing to generate a shell command.'
    }

    $fingerprint = Get-Sha256Fingerprint -Path $script:PublicKeyPath
    if ([string]::IsNullOrWhiteSpace($fingerprint)) {
        Stop-Safely -Reason 'Unable to calculate the public-key SHA256 fingerprint.'
    }

    $script:PublicKey = $publicKey
    $script:Report.LOCAL_KEY_EXISTS = 'YES'
    $script:Report.PUBLIC_KEY_FINGERPRINT = $fingerprint

    Write-Host "PRIVATE_KEY_PATH=$($script:PrivateKeyPath)"
    Write-Host "PUBLIC_KEY_PATH=$($script:PublicKeyPath)"
    Write-Host "PUBLIC_KEY_FINGERPRINT=$fingerprint"
    Write-Host "PUBLIC_KEY_CONTENT=$publicKey"
}

function Show-PublicKeyInstallInstructions {
    Write-Section 'RUN THIS IN THE OCI HOST CONSOLE'

    $commands = @(
        'set -eu',
        'install -d -m 700 /root/.ssh',
        'touch /root/.ssh/authorized_keys',
        'chmod 600 /root/.ssh/authorized_keys',
        "KEY='$($script:PublicKey)'",
        'if ! grep -Fqx -- "$KEY" /root/.ssh/authorized_keys; then',
        '  if [ -s /root/.ssh/authorized_keys ] && [ "$(tail -c 1 /root/.ssh/authorized_keys | wc -l)" -eq 0 ]; then',
        '    printf ''\n'' >> /root/.ssh/authorized_keys',
        '  fi',
        '  printf ''%s\n'' "$KEY" >> /root/.ssh/authorized_keys',
        'fi',
        'chown root:root /root/.ssh /root/.ssh/authorized_keys',
        'chmod 700 /root/.ssh',
        'chmod 600 /root/.ssh/authorized_keys',
        'ssh-keygen -lf /root/.ssh/authorized_keys -E sha256 | awk "{print \$2}"'
    )
    Write-Host ($commands -join [Environment]::NewLine)
    Write-Host ''

    if (-not (Read-YesNo -Prompt 'Have you run the above command successfully on the OCI host? [Y/N]')) {
        Stop-Safely -Reason 'Public-key installation was not confirmed on the OCI host.'
    }
}

function Confirm-HostKey {
    Write-Section 'HOST-KEY VERIFICATION'

    # appleboy/ssh-action pins the FIRST line of DO_SSH_KNOWN_HOSTS and its Go
    # SSH client offers ECDSA first. Scan each key type separately so the
    # emitted block is deterministically ECDSA, ed25519, RSA. A first line that
    # is not the ECDSA key makes every deploy fail with a host key mismatch.
    $ecdsa = @(& ssh-keyscan -T 10 -t ecdsa $script:ProductionHost 2>$null |
        ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
    $ed25519 = @(& ssh-keyscan -T 10 -t ed25519 $script:ProductionHost 2>$null |
        ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
    $rsa = @(& ssh-keyscan -T 10 -t rsa $script:ProductionHost 2>$null |
        ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })

    if ($ecdsa.Count -eq 0) {
        Stop-Safely -Reason 'ssh-keyscan did not return an ecdsa host key.'
    }
    if ($ed25519.Count -eq 0) {
        Stop-Safely -Reason 'ssh-keyscan did not return an ed25519 host key.'
    }
    if ($rsa.Count -eq 0) {
        Stop-Safely -Reason 'ssh-keyscan did not return an RSA host key.'
    }

    $scan = @($ecdsa + $ed25519 + $rsa)
    $firstFields = @($scan[0] -split '\s+')
    if ($firstFields.Count -lt 2 -or $firstFields[1] -ne 'ecdsa-sha2-nistp256') {
        Stop-Safely -Reason 'The first scanned host-key line is not ecdsa-sha2-nistp256; DO_SSH_KNOWN_HOSTS ordering would break deploys.'
    }

    $fingerprintFile = Join-Path $env:TEMP 'easymod_known_hosts_first_line'
    try {
        [System.IO.File]::WriteAllText($fingerprintFile, "$($scan[0])`n")
        $localFingerprint = Get-Sha256Fingerprint -Path $fingerprintFile
    }
    finally {
        Remove-Item -LiteralPath $fingerprintFile -Force -ErrorAction SilentlyContinue
    }
    if ([string]::IsNullOrWhiteSpace($localFingerprint)) {
        Stop-Safely -Reason 'Unable to calculate the scanned host-key fingerprint.'
    }

    [System.IO.File]::WriteAllText($script:KnownHostsPath, (($scan -join "`n") + "`n"))

    Write-Host "LOCAL_SCANNED_HOST_FINGERPRINT=$localFingerprint"
    Write-Host ''
    Write-Host 'Verify this independently with the OCI known-hosts generator:' -ForegroundColor Cyan
    Write-Host "  .\scripts\oci\generate-known-hosts.ps1 -TargetHost $($script:ProductionHost)"
    Write-Host 'Compare against the recorded receipt in scripts/oci/README.md.'
    $consoleFingerprint = Read-Host 'Paste the ECDSA fingerprint printed by generate-known-hosts.ps1 (or the README receipt)'

    $expected = Normalize-Fingerprint -Value $localFingerprint
    $actual = Normalize-Fingerprint -Value $consoleFingerprint
    if ([string]::IsNullOrWhiteSpace($actual) -or $actual -ne $expected) {
        $script:Report.HOST_KEY_VERIFICATION = 'FAIL'
        Stop-Safely -Reason 'Host-key fingerprint mismatch; SSH was not attempted.'
    }

    $script:Report.HOST_KEY_VERIFICATION = 'PASS'
    Write-Host 'HOST_KEY_VERIFICATION=PASS' -ForegroundColor Green
}

function Invoke-StrictSsh {
    param([Parameter(Mandatory = $true)][string]$RemoteCommand)

    $arguments = @(
        '-i', $script:PrivateKeyPath,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', "UserKnownHostsFile=$($script:KnownHostsPath)",
        "$($script:ProductionUser)@$($script:ProductionHost)",
        $RemoteCommand
    )

    $captured = @(& ssh @arguments 2>&1)
    $exitCode = $LASTEXITCODE
    $lines = @($captured | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
    $joined = $lines -join [Environment]::NewLine
    $authFailure = $joined -match '(?i)permission denied|authentication failed|too many authentication failures|host key verification failed|connection refused|connection timed out|no route to host|could not resolve hostname|connection reset'

    return [pscustomobject]@{
        ExitCode = $exitCode
        Lines = $lines
        AuthFailure = $authFailure
    }
}

function Invoke-SshValidation {
    Write-Section 'SSH READ-ONLY VALIDATION'

    $validationCommand = 'hostname && whoami && test -d /opt/easymod && echo DEPLOY_PATH=PASS && test -f /opt/easymod/.env.prod && echo ENV_FILE=PASS && test -d /opt/easymod/backups && echo BACKUP_DIR=PASS'
    $result = Invoke-StrictSsh -RemoteCommand $validationCommand

    $hasRoot = $result.Lines -contains 'root'
    $hostnameLine = $result.Lines | Where-Object {
        $_ -match '^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$' -and $_ -notin @('root', 'PASS', 'FAIL')
    } | Select-Object -First 1
    $identityReached = (-not $result.AuthFailure) -and $hasRoot -and (-not [string]::IsNullOrWhiteSpace($hostnameLine))

    if ($result.AuthFailure -or -not $identityReached) {
        $script:Report.SSH_AUTH = 'FAIL'
        Write-Host 'SSH_AUTH=FAIL' -ForegroundColor Red
        Write-Host ''
        Write-Host 'Run these diagnostics on the OCI host (OCI Cloud Shell or serial console):' -ForegroundColor Yellow
        Write-Host 'ssh-keygen -lf /root/.ssh/authorized_keys -E sha256'
        Write-Host 'stat -c ''%a %U:%G %n'' /root/.ssh /root/.ssh/authorized_keys'
        Write-Host 'systemctl is-active ssh'
        Add-Blocker -Reason 'SSH authentication or remote identity validation failed.'
        return $false
    }

    $script:Report.SSH_AUTH = 'PASS'
    $script:Report.REMOTE_HOST = $hostnameLine
    $script:Report.REMOTE_USER = if ($hasRoot) { 'root' } else { 'FAIL' }
    $script:Report.DEPLOY_PATH = if ($result.Lines -contains 'DEPLOY_PATH=PASS') { 'PASS' } else { 'FAIL' }
    $script:Report.ENV_FILE = if ($result.Lines -contains 'ENV_FILE=PASS') { 'PASS' } else { 'FAIL' }
    $script:Report.BACKUP_DIR = if ($result.Lines -contains 'BACKUP_DIR=PASS') { 'PASS' } else { 'FAIL' }

    Write-Host 'SSH_AUTH=PASS' -ForegroundColor Green
    Write-Host "REMOTE_HOST=$($script:Report.REMOTE_HOST)"
    Write-Host 'REMOTE_USER=root'
    Write-Host "DEPLOY_PATH=$($script:Report.DEPLOY_PATH)"
    Write-Host "ENV_FILE=$($script:Report.ENV_FILE)"
    Write-Host "BACKUP_DIR=$($script:Report.BACKUP_DIR)"

    if ($script:Report.REMOTE_HOST -notin @('easymod-oci-prod-a1', 'easymod-prod')) {
        Add-Blocker -Reason 'Remote hostname was not the expected OCI production hostname.'
    }
    if ($script:Report.DEPLOY_PATH -ne 'PASS' -or $script:Report.ENV_FILE -ne 'PASS' -or $script:Report.BACKUP_DIR -ne 'PASS') {
        Add-Blocker -Reason 'One or more required remote deployment paths failed validation.'
    }

    return ($script:Report.REMOTE_HOST -in @('easymod-oci-prod-a1', 'easymod-prod') -and
        $script:Report.REMOTE_USER -eq 'root' -and
        $script:Report.DEPLOY_PATH -eq 'PASS' -and
        $script:Report.ENV_FILE -eq 'PASS' -and
        $script:Report.BACKUP_DIR -eq 'PASS')
}

function Get-GitHubSecretNames {
    $names = @(& gh secret list --repo $script:RepoName --json name --jq '.[].name' 2>$null)
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    return @($names | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
}

function Get-GitHubVariableNames {
    $names = @(& gh variable list --repo $script:RepoName --json name --jq '.[].name' 2>$null)
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    return @($names | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
}

function Set-GitHubSecretFromFile {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Path
    )

    Get-Content -LiteralPath $Path -Raw | & gh secret set $Name --repo $script:RepoName 1>$null 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Set-GitHubSecretBody {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Body
    )

    & gh secret set $Name --repo $script:RepoName --body $Body 1>$null 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Install-GitHubSshSecrets {
    param([Parameter(Mandatory = $true)][bool]$SshReady)

    if (-not $SshReady) {
        return
    }

    Write-Section 'GITHUB ACTIONS SSH SECRETS'
    Write-Host 'DO_SSH_PRIVATE_KEY and DO_SSH_KNOWN_HOSTS are not recovery-only: ci-cd.yml, backfill-product-attributes.yml,' -ForegroundColor Yellow
    Write-Host 'grant-platform-admin.yml, and purge-test-account.yml also authenticate with these same secret names.' -ForegroundColor Yellow
    Write-Host 'Continuing will rotate the key those workflows use too. This is safe: the pubkey install step only appends' -ForegroundColor Yellow
    Write-Host 'to authorized_keys, so any existing key on the OCI host keeps working.' -ForegroundColor Yellow
    if (-not (Read-YesNo -Prompt 'Install/update the GitHub Actions SSH secrets now? [Y/N]')) {
        $script:Report.DO_SSH_PRIVATE_KEY_GITHUB = 'NOT_REQUESTED'
        $script:Report.DO_SSH_KNOWN_HOSTS_GITHUB = 'NOT_REQUESTED'
        $script:Report.DEPLOY_HOST_GITHUB = 'NOT_REQUESTED'
        return
    }

    $privateSet = Set-GitHubSecretFromFile -Name 'DO_SSH_PRIVATE_KEY' -Path $script:PrivateKeyPath
    $knownHostsSet = Set-GitHubSecretFromFile -Name 'DO_SSH_KNOWN_HOSTS' -Path $script:KnownHostsPath
    $deployHostSet = Set-GitHubSecretBody -Name 'DEPLOY_HOST' -Body $script:ProductionHost

    $script:SecretNames = Get-GitHubSecretNames
    if ($null -eq $script:SecretNames) {
        Add-Blocker -Reason 'gh secret list could not verify GitHub secret presence.'
        $script:Report.DO_SSH_PRIVATE_KEY_GITHUB = if ($privateSet) { 'SET_UNVERIFIED' } else { 'MISSING' }
        $script:Report.DO_SSH_KNOWN_HOSTS_GITHUB = if ($knownHostsSet) { 'SET_UNVERIFIED' } else { 'MISSING' }
        $script:Report.DEPLOY_HOST_GITHUB = if ($deployHostSet) { 'SET_UNVERIFIED' } else { 'MISSING' }
        return
    }

    $script:Report.DO_SSH_PRIVATE_KEY_GITHUB = if ($script:SecretNames -contains 'DO_SSH_PRIVATE_KEY') { 'PRESENT' } else { 'MISSING' }
    $script:Report.DO_SSH_KNOWN_HOSTS_GITHUB = if ($script:SecretNames -contains 'DO_SSH_KNOWN_HOSTS') { 'PRESENT' } else { 'MISSING' }
    $script:Report.DEPLOY_HOST_GITHUB = if ($script:SecretNames -contains 'DEPLOY_HOST') { 'PRESENT' } else { 'MISSING' }

    if ($script:Report.DO_SSH_PRIVATE_KEY_GITHUB -eq 'MISSING' -or
        $script:Report.DO_SSH_KNOWN_HOSTS_GITHUB -eq 'MISSING' -or
        $script:Report.DEPLOY_HOST_GITHUB -eq 'MISSING') {
        Add-Blocker -Reason 'One or more required GitHub SSH secrets are missing.'
    }
}

function Get-RepoPathInteractively {
    Write-Section 'MONOREPO WORKFLOW CONTRACT'

    $entered = Read-Host "Monorepo path [$($script:DefaultRepoPath)]"
    if ([string]::IsNullOrWhiteSpace($entered)) {
        $entered = $script:DefaultRepoPath
    }
    $entered = $entered.Trim().Trim('"')

    if (-not (Test-Path -LiteralPath $entered -PathType Container)) {
        Stop-Safely -Reason "Monorepo path does not exist: $entered"
    }

    $script:RepoPath = (Resolve-Path -LiteralPath $entered).Path.TrimEnd('\')
}

function Get-ContractFiles {
    $roots = @(
        (Join-Path $script:RepoPath '.github\workflows'),
        (Join-Path $script:RepoPath 'scripts\recovery-gate')
    )
    $files = @()
    foreach ($root in $roots) {
        if (Test-Path -LiteralPath $root -PathType Container) {
            $files += @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue)
        }
    }
    return @($files | Sort-Object -Property FullName -Unique)
}

function Get-ExactNameMatches {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.IO.FileInfo[]]$Files,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $pattern = "(?<![A-Z0-9_])$([Regex]::Escape($Name))(?![A-Z0-9_])"
    return @($Files | Select-String -Pattern $pattern)
}

function Get-RepoRelativePath {
    param([Parameter(Mandatory = $true)][string]$FullName)
    return $FullName.Substring($script:RepoPath.Length).TrimStart('\')
}

function Inspect-WorkflowContract {
    $files = Get-ContractFiles
    if ($files.Count -eq 0) {
        $script:Report.WORKFLOW_SSH_USER_CONTRACT = 'NO_INSPECTED_FILES'
        Stop-Safely -Reason 'The expected .github/workflows or scripts/recovery-gate files were not found.'
    }

    $names = @(
        'DO_SSH_PRIVATE_KEY', 'DO_SSH_KNOWN_HOSTS', 'DEPLOY_HOST', 'DEPLOY_USER',
        'SERVER_USER', 'SSH_USER',
        'SPACES_ACCESS_KEY_ID', 'SPACES_SECRET_ACCESS_KEY', 'SPACES_ENDPOINT',
        'BACKUP_BUCKET', 'BACKUP_ENCRYPTION_KEY',
        'OCI_AUDIT_PRIVATE_KEY', 'OCI_AUDIT_TENANCY_OCID', 'OCI_AUDIT_USER_OCID',
        'OCI_AUDIT_FINGERPRINT', 'OCI_AUDIT_NAMESPACE', 'OCI_AUDIT_REGION'
    )
    $rows = @()
    $matchMap = @{}

    foreach ($name in $names) {
        $matches = @(Get-ExactNameMatches -Files $files -Name $name)
        $matchMap[$name] = $matches
        $fileList = @($matches | ForEach-Object { Get-RepoRelativePath -FullName $_.Path } | Sort-Object -Unique)
        $rows += [pscustomobject]@{
            VARIABLE_NAME = $name
            REFERENCED = if ($fileList.Count -gt 0) { 'YES' } else { 'NO' }
            FILES = if ($fileList.Count -gt 0) { $fileList -join ', ' } else { '' }
        }
    }

    $rows | Format-Table -Property VARIABLE_NAME, REFERENCED, FILES -AutoSize | Out-Host

    $sshUserNames = @('DEPLOY_USER', 'SERVER_USER', 'SSH_USER') | Where-Object {
        @($matchMap[$_]).Count -gt 0
    }
    if ($sshUserNames.Count -gt 0) {
        $script:Report.WORKFLOW_SSH_USER_CONTRACT = $sshUserNames -join ','
        Write-Host "SSH_USER_VARIABLES_REQUIRED=$($sshUserNames -join ',')" -ForegroundColor Yellow
    } else {
        $script:Report.WORKFLOW_SSH_USER_CONTRACT = 'NO_SSH_USER_SECRET_REFERENCED'
        Write-Host 'SSH_USER_VARIABLES_REQUIRED=NONE_FOUND; inspect any hard-coded workflow username separately.'
    }

    $spaceNames = $script:OffsiteSecretNames
    $required = @($spaceNames | Where-Object { @($matchMap[$_]).Count -gt 0 })
    $script:RequiredSpaceNames = $required
    $script:Report.SPACES_CONFIGURATION_REQUIRED = if ($required.Count -gt 0) { 'YES' } else { 'NO' }

    $secretNames = @($required | Where-Object {
        @($matchMap[$_] | Where-Object { $_.Line -match '(?i)secrets\.' }).Count -gt 0
    })
    $variableNames = @($required | Where-Object {
        @($matchMap[$_] | Where-Object { $_.Line -match '(?i)(envs:|vars\.|environment|export|\$env:)' }).Count -gt 0
    })
    Write-Host ('SPACES_CONFIGURATION_REQUIRED=' + $script:Report.SPACES_CONFIGURATION_REQUIRED)
    Write-Host ('REQUIRED_SPACES_SECRETS=' + $(if ($secretNames.Count -gt 0) { $secretNames -join ',' } else { 'NONE_FOUND' }))
    Write-Host ('REQUIRED_SPACES_VARIABLES=' + $(if ($variableNames.Count -gt 0) { $variableNames -join ',' } else { 'NONE_FOUND' }))
}

function Invoke-RemoteReadOnlyInspection {
    param([Parameter(Mandatory = $true)][bool]$SshReady)

    if (-not $SshReady) {
        return
    }

    Write-Section 'READ-ONLY PRODUCTION INSPECTION'
    $remoteCommand = @'
set -u

if command -v docker >/dev/null 2>&1; then
  docker ps --format 'CONTAINER={{.Names}} STATUS={{.Status}}' 2>/dev/null || echo DOCKER_PS=FAIL
else
  echo DOCKER_PS=FAIL
fi

if [ -d /opt/easymod/backups ]; then
  echo "BACKUP_LISTING_ENTRIES=$(ls -lah /opt/easymod/backups 2>/dev/null | tail -n +2 | wc -l)"
  echo "BACKUP_TOTAL_SIZE=$(du -sh /opt/easymod/backups 2>/dev/null | awk '{print $1}')"
else
  echo 'BACKUP_LISTING_ENTRIES=0'
  echo 'BACKUP_TOTAL_SIZE=NOT_FOUND'
fi

echo "ROOT_DISK_USAGE=$(df -h / 2>/dev/null | awk 'NR==2 {print $5}')"

for name in DATABASE_URL REDIS_URL QDRANT_URL QDRANT_API_KEY QDRANT_COLLECTION SPACES_ACCESS_KEY_ID SPACES_SECRET_ACCESS_KEY SPACES_ENDPOINT BACKUP_BUCKET BACKUP_ENCRYPTION_KEY; do
  if grep -Eq "^[[:space:]]*$name[[:space:]]*=" /opt/easymod/.env.prod 2>/dev/null; then
    printf '%s=PRESENT\n' "$name"
  else
    printf '%s=ABSENT\n' "$name"
  fi
done

db_path=$(find /opt/easymod/backups -maxdepth 1 -type f -name 'easymod-*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)
if [ -n "$db_path" ]; then
  echo 'DATABASE_BACKUP_FOUND=YES'
  if pg_restore -l "$db_path" >/dev/null 2>&1; then echo 'DATABASE_BACKUP_CUSTOM_FORMAT=PASS'; else echo 'DATABASE_BACKUP_CUSTOM_FORMAT=FAIL'; fi
  echo "DATABASE_BACKUP_SHA256=$(sha256sum "$db_path" | awk '{print $1}')"
else
  echo 'DATABASE_BACKUP_FOUND=NO'
  echo 'DATABASE_BACKUP_CUSTOM_FORMAT=FAIL'
  echo 'DATABASE_BACKUP_SHA256=NOT_FOUND'
fi

media_path=$(find /opt/easymod/backups -maxdepth 1 -type f -name 'easymod-uploads-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)
if [ -n "$media_path" ]; then
  echo 'MEDIA_BACKUP_FOUND=YES'
  if gzip -t "$media_path" >/dev/null 2>&1; then echo 'MEDIA_BACKUP_GZIP=PASS'; else echo 'MEDIA_BACKUP_GZIP=FAIL'; fi
  if tar -tzf "$media_path" >/dev/null 2>&1; then echo 'MEDIA_BACKUP_ARCHIVE=PASS'; else echo 'MEDIA_BACKUP_ARCHIVE=FAIL'; fi
  echo "MEDIA_BACKUP_SHA256=$(sha256sum "$media_path" | awk '{print $1}')"
else
  echo 'MEDIA_BACKUP_FOUND=NO'
  echo 'MEDIA_BACKUP_GZIP=FAIL'
  echo 'MEDIA_BACKUP_ARCHIVE=FAIL'
  echo 'MEDIA_BACKUP_SHA256=NOT_FOUND'
fi
'@

    $result = Invoke-StrictSsh -RemoteCommand $remoteCommand
    if ($result.AuthFailure -or $result.ExitCode -ne 0) {
        Add-Blocker -Reason 'Read-only production inspection failed.'
        return
    }

    $allowedPrefixes = @(
        'CONTAINER=', 'DOCKER_PS=', 'BACKUP_LISTING_ENTRIES=', 'BACKUP_TOTAL_SIZE=',
        'ROOT_DISK_USAGE=', 'DATABASE_URL=', 'REDIS_URL=', 'QDRANT_URL=',
        'QDRANT_API_KEY=', 'QDRANT_COLLECTION=', 'SPACES_ACCESS_KEY_ID=',
        'SPACES_SECRET_ACCESS_KEY=', 'SPACES_ENDPOINT=', 'BACKUP_BUCKET=',
        'BACKUP_ENCRYPTION_KEY=', 'DATABASE_BACKUP_FOUND=', 'DATABASE_BACKUP_CUSTOM_FORMAT=',
        'DATABASE_BACKUP_SHA256=', 'MEDIA_BACKUP_FOUND=', 'MEDIA_BACKUP_GZIP=',
        'MEDIA_BACKUP_ARCHIVE=', 'MEDIA_BACKUP_SHA256='
    )
    foreach ($line in $result.Lines) {
        if (@($allowedPrefixes | Where-Object { $line.StartsWith($_) }).Count -gt 0) {
            Write-Host $line
        }

        foreach ($key in @(
        'DATABASE_BACKUP_FOUND', 'DATABASE_BACKUP_CUSTOM_FORMAT', 'DATABASE_BACKUP_SHA256',
            'MEDIA_BACKUP_FOUND', 'MEDIA_BACKUP_GZIP', 'MEDIA_BACKUP_ARCHIVE',
            'MEDIA_BACKUP_SHA256', 'BACKUP_TOTAL_SIZE', 'ROOT_DISK_USAGE'
        )) {
            if ($line -match "^$key=(.*)$") {
                $script:Report[$key] = $Matches[1]
            }
        }
    }
}

function Get-ConfiguredSecretStatus {
    param([Parameter(Mandatory = $true)][string[]]$Names)

    if ($null -eq $script:SecretNames) {
        return 'NOT_CHECKED'
    }

    $required = @($Names | Where-Object { $script:RequiredSpaceNames -contains $_ })
    if ($required.Count -eq 0) {
        return 'NOT_REQUIRED_BY_REPO'
    }
    if (@($required | Where-Object { $script:SecretNames -contains $_ }).Count -gt 0) {
        return 'PRESENT'
    }
    return 'MISSING'
}

function Update-OciAuditReport {
    if ($null -eq $script:SecretNames) {
        $script:SecretNames = Get-GitHubSecretNames
    }
    if ($null -eq $script:SecretNames) {
        $script:Report.OCI_AUDIT_PRIVATE_KEY_GITHUB = 'NOT_CHECKED'
    } else {
        $auditKeyPresent = @($script:OciAuditSecretNames | Where-Object { $script:SecretNames -contains $_ }).Count -gt 0
        $script:Report.OCI_AUDIT_PRIVATE_KEY_GITHUB = if ($auditKeyPresent) { 'PRESENT' } else { 'MISSING_OPTIONAL' }
    }

    $variableNames = Get-GitHubVariableNames
    if ($null -eq $variableNames) {
        foreach ($name in $script:OciAuditVariableNames) {
            $script:Report["$($name)_VARIABLE"] = 'NOT_CHECKED'
        }
        return
    }
    foreach ($name in $script:OciAuditVariableNames) {
        $script:Report["$($name)_VARIABLE"] = if ($variableNames -contains $name) { 'PRESENT' } else { 'MISSING_OPTIONAL' }
    }
}

function Update-SpacesSecretReport {
    if ($null -eq $script:SecretNames) {
        $script:SecretNames = Get-GitHubSecretNames
    }
    $script:Report.SPACES_ACCESS_KEY_GITHUB = Get-ConfiguredSecretStatus -Names @('SPACES_ACCESS_KEY_ID')
    $script:Report.SPACES_SECRET_KEY_GITHUB = Get-ConfiguredSecretStatus -Names @('SPACES_SECRET_ACCESS_KEY')
    $script:Report.SPACES_BUCKET_CONFIGURED = Get-ConfiguredSecretStatus -Names @('BACKUP_BUCKET')
    $script:Report.SPACES_REGION_CONFIGURED = Get-ConfiguredSecretStatus -Names @('SPACES_ENDPOINT')

    if ($script:Report.SPACES_CONFIGURATION_REQUIRED -eq 'YES' -and $null -ne $script:SecretNames) {
        $missing = @($script:RequiredSpaceNames | Where-Object { $script:SecretNames -notcontains $_ })
        if ($missing.Count -gt 0) {
            Add-Blocker -Reason 'Required off-site OCI Object Storage GitHub secrets are missing.'
        }
    }
}

function Write-FinalReport {
    Write-Section 'EASYMOD RECOVERY SSH REPORT'
    Write-Host ''
    Write-Host '=== EASYMOD RECOVERY SSH REPORT ==='
    foreach ($key in @(
        'LOCAL_KEY_EXISTS', 'PUBLIC_KEY_FINGERPRINT', 'HOST_KEY_VERIFICATION',
        'SSH_AUTH', 'REMOTE_HOST', 'REMOTE_USER', 'DEPLOY_PATH', 'ENV_FILE',
        'BACKUP_DIR', 'DO_SSH_PRIVATE_KEY_GITHUB', 'DO_SSH_KNOWN_HOSTS_GITHUB',
        'DEPLOY_HOST_GITHUB', 'WORKFLOW_SSH_USER_CONTRACT', 'DATABASE_BACKUP_FOUND',
        'DATABASE_BACKUP_CUSTOM_FORMAT', 'DATABASE_BACKUP_SHA256', 'MEDIA_BACKUP_FOUND',
        'MEDIA_BACKUP_GZIP', 'MEDIA_BACKUP_ARCHIVE', 'MEDIA_BACKUP_SHA256',
        'BACKUP_TOTAL_SIZE', 'ROOT_DISK_USAGE', 'SPACES_CONFIGURATION_REQUIRED',
        'SPACES_ACCESS_KEY_GITHUB', 'SPACES_SECRET_KEY_GITHUB',
        'SPACES_BUCKET_CONFIGURED', 'SPACES_REGION_CONFIGURED',
        'OCI_AUDIT_PRIVATE_KEY_GITHUB', 'OCI_AUDIT_TENANCY_OCID_VARIABLE',
        'OCI_AUDIT_USER_OCID_VARIABLE', 'OCI_AUDIT_FINGERPRINT_VARIABLE',
        'OCI_AUDIT_NAMESPACE_VARIABLE', 'OCI_AUDIT_REGION_VARIABLE',
        'NEXT_BLOCKER'
    )) {
        Write-Host "$key=$($script:Report[$key])"
    }
}

try {
    Write-Section 'PREFLIGHT'
    Assert-CommandAvailable -Names @('ssh', 'ssh-keygen', 'ssh-keyscan', 'gh')

    & gh auth status 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) {
        Stop-Safely -Reason 'GitHub CLI is not authenticated. Run gh auth login, then rerun this script.'
    }
    Write-Host 'GH_AUTH=PASS'

    Initialize-Key
    Show-PublicKeyInstallInstructions
    Confirm-HostKey

    $sshReady = Invoke-SshValidation
    Install-GitHubSshSecrets -SshReady $sshReady

    Get-RepoPathInteractively
    Inspect-WorkflowContract
    Update-OciAuditReport
    Update-SpacesSecretReport
    Invoke-RemoteReadOnlyInspection -SshReady $sshReady

    if ($script:Report.NEXT_BLOCKER -eq 'NONE') {
        $script:Report.NEXT_BLOCKER = 'NONE; no deployment, restart, restore, or traffic switch was performed.'
    }
}
catch [System.OperationCanceledException] {
    $script:ExitCode = 1
    Write-Warning 'Stopped safely. No production mutation was attempted.'
}
catch {
    $script:ExitCode = 1
    if ($script:Report.NEXT_BLOCKER -eq 'NONE') {
        $script:Report.NEXT_BLOCKER = 'UNEXPECTED_LOCAL_ERROR'
    }
    Write-Warning 'Stopped because of an unexpected local error. No secret value or raw command output was printed.'
}
finally {
    Write-FinalReport
}

exit $script:ExitCode
