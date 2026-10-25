param(
    [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start',
    [int]$EnginePort = 8765,
    [int]$WebPort = 5173,
    [switch]$OpenBrowser
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$devRoot = Join-Path $repoRoot '.local-plans/dev'
if ([IO.Path]::GetPathRoot($devRoot) -eq 'C:\') { throw 'Place the checkout on a non-C drive before starting local development.' }
$statePath = Join-Path $devRoot 'processes.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-State {
    if (Test-Path -LiteralPath $statePath) { return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json }
    return $null
}
function Get-OwnedProcess($saved) {
    if (!$saved) { return $null }
    $proc = Get-Process -Id $saved.id -ErrorAction SilentlyContinue
    if ($proc -and $proc.StartTime.ToUniversalTime().Ticks.ToString() -eq $saved.started -and $proc.Path -eq $saved.path) { return $proc }
    return $null
}
function Save-Process($proc) {
    return @{ id=$proc.Id; started=$proc.StartTime.ToUniversalTime().Ticks.ToString(); path=$proc.Path }
}
function Open-DevBrowser([string]$url) {
    $edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft/Edge/Application/msedge.exe'
    if (!(Test-Path -LiteralPath $edge)) { throw 'Microsoft Edge is not installed.' }
    $profile = Join-Path $devRoot 'browser-profile'
    $token = [IO.File]::ReadAllText((Join-Path $devRoot 'engine-token.txt')).Trim()
    Start-Process -FilePath $edge -ArgumentList @('--new-window', ('--user-data-dir="'+$profile+'"'), "${url}?demo=0&token=$token#/providers/local-pi") | Out-Null
}
$state = Read-State
if ($Action -eq 'Status') {
    if (!$state) { Write-Output 'Local development is not started.'; exit 0 }
    Write-Output "Engine running: $([bool](Get-OwnedProcess $state.engine)); Web running: $([bool](Get-OwnedProcess $state.web))"
    Write-Output "URL: $($state.url)"
    Write-Output "Data: $devRoot"
    exit 0
}
if ($Action -eq 'Stop') {
    if ($state) {
        foreach ($saved in @($state.web, $state.engine)) {
            $proc = Get-OwnedProcess $saved
            if ($proc) { Stop-Process -InputObject $proc; Write-Output "Stopped local process $($proc.Id)." }
        }
    }
    Write-Output 'Local services stopped. Test data is retained.'
    exit 0
}
if ((Get-OwnedProcess $state.engine) -or (Get-OwnedProcess $state.web)) {
    if ($OpenBrowser -and (Get-OwnedProcess $state.engine) -and (Get-OwnedProcess $state.web)) { Open-DevBrowser $state.url }
    Write-Output 'Local services already exist. Use -Action Status or -Action Stop.'
    exit 0
}
foreach ($port in @($EnginePort, $WebPort)) {
    $probe = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port)
    try { $probe.Start() } catch { throw "Port $port is in use. Stop its owner or choose another port." } finally { $probe.Stop() }
}
foreach ($part in @('home/config','workspace','logs','tmp','cache/npm','cache/pip','cache/browsers','cache/gradle','browser-profile')) {
    New-Item -ItemType Directory -Force (Join-Path $devRoot $part) | Out-Null
}
$env:TEMP = Join-Path $devRoot 'tmp'
$env:TMP = $env:TEMP
$env:npm_config_cache = Join-Path $devRoot 'cache/npm'
$env:PIP_CACHE_DIR = Join-Path $devRoot 'cache/pip'
$env:GRADLE_USER_HOME = Join-Path $devRoot 'cache/gradle'
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $devRoot 'cache/browsers'
$env:CARGO_TARGET_DIR = Join-Path $repoRoot 'apps/coomi-rs/target'
if (!$env:CARGO_HOME -or [IO.Path]::GetPathRoot($env:CARGO_HOME) -eq 'C:\') { $env:CARGO_HOME = Join-Path $devRoot 'cache/cargo' }
# Existing rustup is already on E: on the development machine. Refuse an implicit toolchain download to C:.
if (!$env:RUSTUP_HOME -or [IO.Path]::GetPathRoot($env:RUSTUP_HOME) -eq 'C:\') { throw 'Set RUSTUP_HOME to an installed Rust toolchain directory on a non-C drive.' }
$node = (Get-Command node.exe).Source
$npm = (Get-Command npm.cmd).Source
$cargo = (Get-Command cargo.exe).Source
Push-Location $repoRoot
try {
    if (!(Test-Path -LiteralPath 'apps/web/node_modules/vite/bin/vite.js')) {
        & $npm --prefix apps/web ci
        if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
    }
    $ErrorActionPreference = 'Continue'
    & $npm --prefix apps/web run build *> (Join-Path $devRoot 'logs/web-build.log')
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed: $devRoot/logs/web-build.log" }
    $ErrorActionPreference = 'Continue'
    & $cargo build --manifest-path apps/coomi-rs/Cargo.toml -p coomi-ui --locked *> (Join-Path $devRoot 'logs/rust-build.log')
    $ErrorActionPreference = 'Stop'
    if ($LASTEXITCODE -ne 0) { throw "Rust build failed: $devRoot/logs/rust-build.log" }
    $providerPath = Join-Path $devRoot 'home/config/providers.json'
    if (!(Test-Path -LiteralPath $providerPath)) {
        $draft = @{active=''; providers=@{'local-pi'=@{type='openai_compatible'; display='本机 Pi'; api_key=''; base_url=''; model=''; models=@('deepseek-v4.1-flash-1017')}}}
        [IO.File]::WriteAllText($providerPath, ($draft | ConvertTo-Json -Depth 8), $utf8)
    }
    $instructions = Join-Path $devRoot 'workspace/AGENTS.md'
    if (!(Test-Path -LiteralPath $instructions)) {
        [IO.File]::WriteAllText($instructions, "这是 Coomi 本机测试工作区。使用 Windows PowerShell 和本机路径；所有测试产物留在当前工作区。下载、依赖和大文件必须放到 E 盘，缓存目录使用父进程提供的环境变量。不要读取其他应用的凭据。", $utf8)
    }
    $tokenPath = Join-Path $devRoot 'engine-token.txt'
    if (!(Test-Path -LiteralPath $tokenPath)) { [IO.File]::WriteAllText($tokenPath, [Guid]::NewGuid().ToString('N'), $utf8) }
    $token = [IO.File]::ReadAllText($tokenPath).Trim()
    $engineExe = Join-Path $repoRoot 'apps/coomi-rs/target/debug/coomi.exe'
    $engineArgs = @('--home', ('"' + (Join-Path $devRoot 'home') + '"'), '--cwd', ('"' + (Join-Path $devRoot 'workspace') + '"'),
        'serve', '--port', $EnginePort, '--token', $token, '--static-dir', ('"' + (Join-Path $repoRoot 'apps/web/dist') + '"'))
    $engine = Start-Process -FilePath $engineExe -ArgumentList $engineArgs -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $devRoot 'logs/engine.log') -RedirectStandardError (Join-Path $devRoot 'logs/engine-error.log')
    $env:COOMI_DEV_ENGINE = "http://127.0.0.1:$EnginePort"
    $env:COOMI_DEV_PORT = "$WebPort"
    Remove-Item Env:VITE_ENGINE_WS -ErrorAction SilentlyContinue
    $vite = Join-Path $repoRoot 'apps/web/node_modules/vite/bin/vite.js'
    $web = Start-Process -FilePath $node -ArgumentList @(('"'+$vite+'"')) -WorkingDirectory (Join-Path $repoRoot 'apps/web') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $devRoot 'logs/web.log') -RedirectStandardError (Join-Path $devRoot 'logs/web-error.log')
    $url = "http://127.0.0.1:$WebPort/"
    [IO.File]::WriteAllText($statePath, (@{engine=(Save-Process $engine); web=(Save-Process $web); url=$url; enginePort=$EnginePort; webPort=$WebPort} | ConvertTo-Json -Depth 5), $utf8)
    $ready = $false
    for ($attempt=0; $attempt -lt 40; $attempt++) {
        try {
            $health = Invoke-RestMethod "${url}api/runtime/health" -TimeoutSec 2
            if ($health.status -eq 'ok') { $ready=$true; break }
        } catch { Start-Sleep -Milliseconds 300 }
    }
    if (!$ready) { throw "Local services did not become ready. See $devRoot/logs and run -Action Stop before retrying." }
    Write-Output "Local development is ready: $url"
    Write-Output "Data, logs and caches: $devRoot"
    if ($OpenBrowser) { Open-DevBrowser $url }
} finally { Pop-Location }
