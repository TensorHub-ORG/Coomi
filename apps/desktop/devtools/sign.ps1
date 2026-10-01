<#
.SYNOPSIS
  Coomi 桌面端签名/验签工具（可被 Tauri 的 signCommand 调用）。

.DESCRIPTION
  凭据优先级：命令行参数 > 环境变量（COOMI_SIGN_MODE / COOMI_SIGN_PFX /
  COOMI_SIGN_PASSWORD / COOMI_SIGN_THUMBPRINT / COOMI_SIGN_TIMESTAMP）。
  被 Tauri 调用时只传 -Path %1，凭据全部走环境变量，避免密码写进配置。

.EXAMPLE
  # 正式发布（签名流程见 build-signed.ps1）
  ./sign.ps1 -Mode pfx -Pfx D:\cert\coomi.pfx -Password *** -Target release,installer

.EXAMPLE
  # 只验签
  ./sign.ps1 -Mode verify
#>
param(
  [ValidateSet('pfx','thumbprint','self-signed','verify','')][string]$Mode = '',
  [string]$Pfx = '',
  [string]$Password = '',
  [string]$Thumbprint = '',
  [string[]]$Target = @(),
  [string[]]$Path = @(),
  [string]$TimestampUrl = '',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

if (-not $Mode)         { $Mode = $env:COOMI_SIGN_MODE }
if (-not $Pfx)          { $Pfx = $env:COOMI_SIGN_PFX }
if (-not $Password)     { $Password = $env:COOMI_SIGN_PASSWORD }
if (-not $Thumbprint)   { $Thumbprint = $env:COOMI_SIGN_THUMBPRINT }
if (-not $TimestampUrl) { $TimestampUrl = $env:COOMI_SIGN_TIMESTAMP }
if (-not $TimestampUrl) { $TimestampUrl = 'http://timestamp.digicert.com' }
if (-not $Mode)         { $Mode = 'verify' }

$repo = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
$engineExe = Join-Path $repo 'apps\coomi-rs\target\release\coomi.exe'
$shellExe  = Join-Path $repo 'apps\desktop\target\release\coomi-desktop.exe'
$setupExe  = Join-Path $repo 'apps\desktop\target\release\bundle\nsis\Coomi_1.6.6_x64-setup.exe'

function Get-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $found = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
  if ($found) { return $found.FullName }
  throw 'signtool.exe not found: install Windows SDK'
}

$signtool = Get-SignTool

function Invoke-Sign([string]$file, [string[]]$extra) {
  if (-not (Test-Path $file)) { if (-not $Quiet) { Write-Warning ('skip (missing): ' + $file) }; return }
  $signArgs = @('sign','/fd','sha256','/a') + $extra
  if ($TimestampUrl) { $signArgs += @('/tr', $TimestampUrl, '/td', 'sha256') }
  $signArgs += $file
  if (-not $Quiet) { Write-Host ('  sign ' + (Split-Path $file -Leaf)) }
  & $signtool @signArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ('signing failed: ' + $file) }
}

function Show-Status([string[]]$files) {
  foreach ($f in $files) {
    if (-not (Test-Path $f)) { Write-Host ('  [missing] ' + $f); continue }
    $sig = Get-AuthenticodeSignature $f
    $subject = ''
    if ($sig.SignerCertificate) { $subject = ' | signer: ' + $sig.SignerCertificate.Subject }
    Write-Host ('  [' + $sig.Status + '] ' + (Split-Path $f -Leaf) + $subject)
  }
}

# 显式给了 -Path 就只签这些文件（Tauri signCommand 走这条）
$targets = @()
if ($Path.Count -gt 0) {
  $targets = $Path
} else {
  if ($Target.Count -eq 0) { $Target = @('release','installer') }
  if ($Target -contains 'release')   { $targets += $engineExe, $shellExe }
  if ($Target -contains 'installer') { $targets += $setupExe }
}

if (-not $Quiet) { Write-Host ('signtool: ' + $signtool) }

switch ($Mode) {
  'verify' {
    Write-Host 'signature status:'
    Show-Status $targets
  }
  'pfx' {
    if (-not $Pfx -or -not (Test-Path $Pfx)) { throw 'pfx certificate not found (-Pfx / COOMI_SIGN_PFX)' }
    $extra = @('/f', $Pfx)
    if ($Password) { $extra += @('/p', $Password) }
    foreach ($t in $targets) { Invoke-Sign $t $extra }
    Show-Status $targets
  }
  'thumbprint' {
    if (-not $Thumbprint) { throw 'thumbprint not provided (-Thumbprint / COOMI_SIGN_THUMBPRINT)' }
    $extra = @('/sha1', ($Thumbprint -replace '\s',''))
    foreach ($t in $targets) { Invoke-Sign $t $extra }
    Show-Status $targets
  }
  'self-signed' {
    $name = 'CN=Coomi Self-Signed (dev only)'
    $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
      Where-Object { $_.Subject -eq $name } | Select-Object -First 1
    if (-not $cert) {
      if (-not $Quiet) { Write-Host 'creating self-signed code signing cert (trusted on this machine only)' }
      $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $name -KeyUsage DigitalSignature `
        -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(3) -KeyExportPolicy Exportable
      foreach ($store in 'Root','TrustedPublisher') {
        try {
          $s = New-Object System.Security.Cryptography.X509Certificates.X509Store($store, 'CurrentUser')
          $s.Open('ReadWrite'); $s.Add($cert); $s.Close()
        } catch { Write-Warning ('import to ' + $store + ' failed: ' + $_.Exception.Message) }
      }
    }
    if (-not $Quiet) { Write-Host ('self-signed thumbprint: ' + $cert.Thumbprint) }
    $extra = @('/sha1', $cert.Thumbprint)
    foreach ($t in $targets) { Invoke-Sign $t $extra }
    if (-not $Quiet) {
      Show-Status $targets
      Write-Host ''
      Write-Host 'NOTE: self-signed only proves the pipeline; other machines still show an unknown publisher.' -ForegroundColor Yellow
    }
  }
}
