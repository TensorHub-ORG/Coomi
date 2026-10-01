Add-Type -AssemblyName System.Drawing
$dir = "G:/DSH/coomi-full-project/apps/desktop/icons"
$bmp = New-Object System.Drawing.Bitmap 256,256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(255,30,42,66))
$brush = [System.Drawing.Brushes]::White
$fontFamily = [System.Drawing.FontFamily]::new([string]"Segoe UI")
$font = [System.Drawing.Font]::new($fontFamily, 130, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = [System.Drawing.StringFormat]::new()
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = [System.Drawing.RectangleF]::new(0,0,256,256)
$g.DrawString([string]"C", $font, $brush, $rect, $fmt)
$g.Dispose()
$bmp.Save((Join-Path $dir "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("icon.png bytes: " + (Get-Item (Join-Path $dir "icon.png")).Length)




