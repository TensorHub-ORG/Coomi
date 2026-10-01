<#
.SYNOPSIS
  一条命令出「已签名」的 Windows 安装包。

.DESCRIPTION
  顺序很关键：
    1) 先签引擎 exe（它会被原样打包进安装包，Tauri 不会碰它）
    2) 再跑 tauri build，并通过 --config 把 signCommand 交给 Tauri，
       让 Tauri 在「打好包类型补丁之后」给壳 exe 与安装包签名
       （补丁会改写 exe，先签后打会被作废）
    3) 最后验签

.EXAMPLE
  ./build-signed.ps1 -Mode pfx -Pfx D:\cert\coomi.pfx -Password 123456
#>
param(
  [Parameter(Mandatory=$true)][ValidateSet('pfx','thumbprint','self-signed')][string]$Mode,
  [string]$Pfx = '',
  [string]$Password = '',
  [string]$Thumbprint = '',
  [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$repo = Split-Path (Split-Path (Split-Path $here -Parent) -Parent) -Parent
$desktop = Join-Path $repo 'apps\desktop'
$signScript = Join-Path $here 'sign.ps1'

$env:COOMI_SIGN_MODE = $Mode
$env:COOMI_SIGN_PFX = $Pfx
$env:COOMI_SIGN_PASSWORD = $Password
$env:COOMI_SIGN_THUMBPRINT = $Thumbprint
$env:COOMI_SIGN_TIMESTAMP = $TimestampUrl
$env:PATH = 'C:\Users\' + $env:USERNAME + '\.cargo\bin;' + $env:PATH

Write-Host '=== 1/3 sign engine exe (resource inside installer) ==='
& $signScript -Mode $Mode -Path (Join-Path $repo 'apps\coomi-rs\target\release\coomi.exe')

Write-Host '=== 2/3 tauri build (shell exe + installer signed by Tauri via sign.ps1) ==='
$signCmd = @{
  cmd = 'powershell.exe'
  args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$signScript,'-Path','%1')
}
$winCfg = @{ signCommand = $signCmd; digestAlgorithm = 'sha256'; timestampUrl = $TimestampUrl; tsp = $true }
$configJson = @{ bundle = @{ windows = $winCfg } } | ConvertTo-Json -Depth 6
# PowerShell 5.1 会把内联 JSON 参数里的双引号吃掉，所以落成临时文件再传给 Tauri。
$configPath = Join-Path $desktop 'target\sign-config.json'
Set-Content -Path $configPath -Value $configJson -Encoding UTF8
Push-Location $desktop
try {
  # 走 cmd.exe：PowerShell 5.1 会把 npx 的 stderr 当成错误记录，配合 Stop 直接中断构建。
  & cmd.exe /c "npx.cmd tauri build --config `"$configPath`" 2>&1"
  if ($LASTEXITCODE -ne 0) { throw 'tauri build failed' }
} finally { Pop-Location }

Write-Host '=== 3/3 verify ==='
& $signScript -Mode verify

Write-Host ''
Write-Host 'installer: apps/desktop/target/release/bundle/nsis/Coomi_1.6.6_x64-setup.exe'
