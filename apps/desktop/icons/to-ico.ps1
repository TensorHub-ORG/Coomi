Add-Type -AssemblyName System.Drawing
$dir = "G:/DSH/coomi-full-project/apps/desktop/icons"
$png = [System.Drawing.Image]::FromFile((Join-Path $dir "icon.png"))
$bmp = New-Object System.Drawing.Bitmap $png, 256, 256
$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$fs = [System.IO.File]::Create((Join-Path $dir "icon.ico"))
$icon.Save($fs)
$fs.Close()
$icon.Dispose()
$bmp.Dispose()
$png.Dispose()
Write-Output ("icon.ico bytes: " + (Get-Item (Join-Path $dir "icon.ico")).Length)

