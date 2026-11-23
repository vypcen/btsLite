param(
    [Parameter(Mandatory)][ValidateSet('Install', 'Stop', 'Remove')][string]$Action,
    [Parameter(Mandatory)][string]$InstallDir
)
$ErrorActionPreference = 'Stop'
$AppService = 'BlackCatTestingCommunity'
$DbService = 'BlackCatTestingCommunityDb'
$Data = Join-Path $env:ProgramData 'BlackCatTestingCommunity'
$PgData = Join-Path $Data 'postgres'
$PgBin = Join-Path $InstallDir 'pgsql\bin'
$Config = Join-Path $Data 'app.env'
$PgPort = 55432
trap {
    Write-Host $_.InvocationInfo.PositionMessage
    Write-Host $_.Exception.Message
    exit 1
}

function Invoke-Native([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable exited with code $LASTEXITCODE" }
}

function Stop-Community {
    foreach ($name in @($AppService, $DbService)) {
        $service = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($service -and $service.Status -ne 'Stopped') {
            Stop-Service -Name $name
            $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
        }
    }
}

function New-HexSecret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
}

if ($Action -ne 'Install') {
    Stop-Community
    if ($Action -eq 'Remove') {
        foreach ($name in @($AppService, $DbService)) {
            if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
                Invoke-Native 'sc.exe' @('delete', $name)
            }
        }
    }
    exit 0
}

Write-Host 'Preparing Community data directory and permissions'
New-Item -ItemType Directory -Path $Data -Force | Out-Null
$dataDirectory = [System.IO.DirectoryInfo]::new($Data)
if ($dataDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "The data directory must not be a reparse point: $Data"
}
$acl = $dataDirectory.GetAccessControl()
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) {
    $acl.RemoveAccessRuleSpecific($rule)
}
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-19')) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
$dataDirectory.SetAccessControl($acl)
foreach ($directory in @('postgres', 'uploads', 'backups', 'logs')) {
    New-Item -ItemType Directory -Path (Join-Path $Data $directory) -Force | Out-Null
}
Write-Host 'Preparing Community configuration'
if (-not (Test-Path -LiteralPath $Config)) {
    $password = New-HexSecret
    @(
        'NODE_ENV=production'
        'PORT=3002'
        'LISTEN_HOST=127.0.0.1'
        'REGISTRATION=closed'
        'EULA_REQUIRED=true'
        "DATABASE_URL=postgresql://postgres:${password}@127.0.0.1:${PgPort}/postgres"
        ('UPLOAD_DIR="{0}"' -f (Join-Path $Data 'uploads'))
        ('BACKUP_DIR="{0}"' -f (Join-Path $Data 'backups'))
        ('BACKUP_PG_BIN="{0}"' -f $PgBin)
        "APP_SECRET=$(New-HexSecret)"
        "SETUP_CODE=$(New-HexSecret)"
    ) | Set-Content -LiteralPath "$Config.new" -Encoding ASCII
    Move-Item -LiteralPath "$Config.new" -Destination $Config
}
Write-Host 'Preparing the PostgreSQL cluster'
if (-not (Test-Path -LiteralPath (Join-Path $PgData 'PG_VERSION'))) {
    $url = (Get-Content -LiteralPath $Config | Where-Object { $_.StartsWith('DATABASE_URL=') }).Substring(13)
    $password = ([Uri]$url).UserInfo.Split(':', 2)[1]
    $passwordFile = Join-Path $Data 'postgres-init-password'
    # PostgreSQL deliberately removes administrative group privileges in initdb.exe.
    # Temporarily allow the installing identity to initialize the cluster with its restricted token.
    $installer = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $temporaryRule = $null
    if ($installer.Value -notin @('S-1-5-18', 'S-1-5-19')) {
        $temporaryRule = [System.Security.AccessControl.FileSystemAccessRule]::new($installer, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($temporaryRule)
        $dataDirectory.SetAccessControl($acl)
    }
    try {
        Set-Content -LiteralPath $passwordFile -Value $password -Encoding ASCII
        Invoke-Native (Join-Path $PgBin 'initdb.exe') @('-D', $PgData, '--username=postgres', '--encoding=UTF8', '--locale=C', '--auth=scram-sha-256', "--pwfile=$passwordFile")
        Add-Content -LiteralPath (Join-Path $PgData 'postgresql.conf') -Value "listen_addresses = '127.0.0.1'`nport = $PgPort" -Encoding ASCII
    } finally {
        Remove-Item -LiteralPath $passwordFile -ErrorAction SilentlyContinue
        if ($temporaryRule) {
            $acl.RemoveAccessRuleSpecific($temporaryRule)
            $dataDirectory.SetAccessControl($acl)
        }
    }
}
if (-not (Get-Service -Name $DbService -ErrorAction SilentlyContinue)) {
    Invoke-Native (Join-Path $PgBin 'pg_ctl.exe') @('register', '-N', $DbService, '-D', $PgData, '-S', 'auto', '-U', 'NT AUTHORITY\LocalService')
}
if (-not (Get-Service -Name $AppService -ErrorAction SilentlyContinue)) {
    Invoke-Native (Join-Path $InstallDir 'community-service.exe') @('install')
}
Start-Service -Name $DbService
Start-Service -Name $AppService
for ($attempt = 0; $attempt -lt 45; $attempt++) {
    try {
        if ((Invoke-WebRequest -Uri 'http://127.0.0.1:3002/readyz' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { exit 0 }
    } catch {
        Start-Sleep -Seconds 1
    }
}
throw "BlackCat Testing Community did not start. Check $Data\logs."
