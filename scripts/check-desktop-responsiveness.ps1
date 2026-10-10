param(
    [int]$ProcessId = 0,
    [ValidateRange(20, 120)][int]$Samples = 60,
    [string]$OutputPath = ''
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CoomiWindowProbe {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
        IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
$desktop = if ($ProcessId) { Get-Process -Id $ProcessId } else {
    Get-Process -Name 'coomi-desktop' | Where-Object MainWindowHandle | Select-Object -First 1
}
if (!$desktop -or !$desktop.MainWindowHandle) { throw 'Coomi desktop window is not running.' }
$latencies = @()
$timeouts = 0
for ($i = 0; $i -lt $Samples; $i++) {
    $reply = [UIntPtr]::Zero
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $ok = [CoomiWindowProbe]::SendMessageTimeout($desktop.MainWindowHandle, 0,
        [UIntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$reply)
    $timer.Stop()
    if ($ok -eq [IntPtr]::Zero) { $timeouts++ }
    $latencies += $timer.Elapsed.TotalMilliseconds
    Start-Sleep -Milliseconds 250
}
$sorted = @($latencies | Sort-Object)
$report = [ordered]@{
    processId = $desktop.Id
    samples = $Samples
    timeouts = $timeouts
    p95Ms = [Math]::Round($sorted[[Math]::Floor($Samples * 0.95)], 2)
    maxMs = [Math]::Round($sorted[-1], 2)
}
$json = $report | ConvertTo-Json
if ($OutputPath) { [IO.File]::WriteAllText($OutputPath, $json) }
$json
if ($timeouts -gt 0 -or $report.p95Ms -gt 250) { exit 1 }
