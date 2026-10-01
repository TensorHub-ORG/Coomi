
$ErrorActionPreference = 'Stop'
$dir = 'G:/DSH/coomi-full-project/docs/plugins/dsh-deep-whale'
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$dir/assets" | Out-Null
$enc = New-Object System.Text.UTF8Encoding($false)

$pluginJson = @'
{
  "id": "dsh-deep-whale",
  "name": "深空蓝鲸",
  "version": "1.0.0",
  "description": "深空蓝鲸主题：灵感来自 DSH 皮肤 GitHub: Small-tailqwq/dsh-deep-whale；纯插件实现，不动引擎。",
  "themeName": "深空蓝鲸",
  "permissions": ["theme.apply"]
}
'@
[IO.File]::WriteAllText("$dir/plugin.json", $pluginJson, $enc)

$themeJson = @'
{
  "name": "深空蓝鲸",
  "colors": {
    "--canvas": "#0a0e17",
    "--canvas-side": "#0d1220",
    "--surface": "#101827",
    "--surface-muted": "#0c1320",
    "--surface-sunken": "#0a101c",
    "--surface-raised": "#141d30",
    "--surface-overlay": "#16203a",
    "--ink": "#e6edf7",
    "--ink-2": "#c3d2e4",
    "--ink-3": "#93a7c2",
    "--ink-4": "#64768f",
    "--ink-inverse": "#0a0e17",
    "--line": "#1e2b3d",
    "--line-soft": "rgba(255,255,255,0.07)",
    "--line-strong": "#2b3d53",
    "--control-bg": "#141d30",
    "--control-bg-2": "#0d1522",
    "--hover": "rgba(79,142,247,0.10)",
    "--active": "rgba(79,142,247,0.16)",
    "--selected": "rgba(79,142,247,0.14)",
    "--primary": "#4f8ef7",
    "--primary-hover": "#6ba2f9",
    "--bubble-user": "#123a66",
    "--bubble-user-line": "#1d4d82",
    "--bubble-user-ink": "#eaf3ff",
    "--code-bg": "#0d121f",
    "--code-fg": "#cce3ff",
    "--msg-card": "#101826",
    "--msg-card-line": "#1d2b40"
  },
  "background": {
    "image": "assets/whale-bg.png",
    "fit": "cover",
    "opacity": 0.6,
    "blur": 18
  },
  "css": [
    "[data-shell-part='rail'] { background: rgba(10,14,23,0.85); }",
    ".bubble.bubble-user { border-radius: 12px 4px 12px 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.35); }",
    "[data-theme-bg] { filter: saturate(0.9); }"
  ]
}
'@
[IO.File]::WriteAllText("$dir/theme.json", $themeJson, $enc)

Add-Type -AssemblyName System.Drawing
$w=1600; $h=1000
$bmp = New-Object System.Drawing.Bitmap($w,$h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$rect = New-Object System.Drawing.Rectangle(0,0,$w,$h)
$c1 = [System.Drawing.Color]::FromArgb(255,22,52,97)
$c2 = [System.Drawing.Color]::FromArgb(255,10,14,23)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,$c1,$c2,[float]55)
$g.FillRectangle($brush,$rect)
$whale = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(60,10,14,23))
$g.FillEllipse($whale, ($w*0.62), ($h*0.70), 260, 110)
$g.FillEllipse($whale, ($w*0.60), ($h*0.66), 90, 80)
$g.FillRectangle($whale, ($w*0.92), ($h*0.70), 60, 40)
$bmp.Save("$dir/assets/whale-bg.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ('ASSETS=' + (Test-Path "$dir/assets/whale-bg.png"))

$zip = 'C:/Users/Monai-Bob/Desktop/dsh-deep-whale.zip'
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$dir/*" -DestinationPath $zip -Force
Write-Output ('ZIP=' + $zip + ' SIZE=' + (Get-Item $zip).Length)

$tmp='C:/Users/Monai-Bob/AppData/Local/Temp/dsh-verify'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -Path $zip -DestinationPath $tmp -Force
Write-Output ('ROOT=' + ((Get-ChildItem $tmp | Select-Object -ExpandProperty Name) -join ', '))
