$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$payload = New-Item -ItemType Directory -Path 'windows-payload' -Force
$cache = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP 'community-downloads') -Force
$pg = Join-Path $cache 'postgres.zip'
$version = node -p "require('./package.json').version"
if ($LASTEXITCODE -ne 0) { throw 'Failed to read app version' }

Invoke-WebRequest 'https://get.enterprisedb.com/postgresql/postgresql-16.15-1-windows-x64-binaries.zip' -OutFile $pg
$expected = '25e6fcdfb8caec38691bf461125e7564508760666f7b8e5dc6a5f0818f58f81e'
if ((Get-FileHash -LiteralPath $pg -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'PostgreSQL archive checksum mismatch'
}
Expand-Archive -LiteralPath $pg -DestinationPath $cache -Force
New-Item -ItemType Directory -Path (Join-Path $payload 'pgsql') -Force | Out-Null
foreach ($item in @('bin', 'lib', 'share')) {
    Copy-Item -LiteralPath (Join-Path $cache "pgsql\$item") -Destination (Join-Path $payload 'pgsql') -Recurse
}
Get-ChildItem (Join-Path $cache 'pgsql') -File | Where-Object Name -Match 'COPYRIGHT|LICENSE' |
    Copy-Item -Destination (Join-Path $payload 'pgsql')
Copy-Item (Get-Command node.exe).Source (Join-Path $payload 'node.exe')
Invoke-WebRequest 'https://raw.githubusercontent.com/nodejs/node/v24.22.3/LICENSE' -OutFile (Join-Path $payload 'LICENSE-Node.txt')
Invoke-WebRequest 'https://raw.githubusercontent.com/postgres/postgres/REL_16_15/COPYRIGHT' -OutFile (Join-Path $payload 'LICENSE-PostgreSQL.txt')
$winsw = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe'
$wrapper = Join-Path $payload 'community-service.exe'
Invoke-WebRequest $winsw -OutFile $wrapper
if ((Get-FileHash -LiteralPath $wrapper -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f') {
    throw 'WinSW checksum mismatch'
}
Invoke-WebRequest 'https://raw.githubusercontent.com/winsw/winsw/v2.12.0/LICENSE.txt' -OutFile (Join-Path $payload 'LICENSE-WinSW.txt')

$iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
if (-not (Test-Path -LiteralPath $iscc)) {
    choco install innosetup --yes --no-progress
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup installation failed' }
}
& $iscc "/DProductVersion=$version" 'packaging\windows\community.iss'
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup build failed' }
