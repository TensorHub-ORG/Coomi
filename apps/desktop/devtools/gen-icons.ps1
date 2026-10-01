Add-Type -AssemblyName System.Drawing
$logo='G:/DSH/coomi-full-project/.apk-full/res/drawable-nodpi-v4/coomi_logo.png'
$iconDir='G:/DSH/coomi-full-project/apps/desktop/icons'
$source=[System.Drawing.Image]::FromFile($logo)
function PngBytes($img,$size){
  $bmp=New-Object System.Drawing.Bitmap $size,$size
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($img,0,0,$size,$size)
  $g.Dispose()
  $ms=New-Object System.IO.MemoryStream
  $bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $bytes=$ms.ToArray()
  $ms.Dispose()
  return ,$bytes
}
$sizes=@(16,32,48,64,128,256)
$blobs=New-Object System.Collections.ArrayList
foreach($s in $sizes){ [void]$blobs.Add((PngBytes $source $s)) }
Write-Output ('blob count=' + $blobs.Count + ' sizes=' + (($blobs | ForEach-Object { $_.Length }) -join ','))
$out=New-Object System.Collections.Generic.List[byte]
$out.AddRange([byte[]]@(0,0, 1,0, [byte]$sizes.Count, 0))
$offset=6+16*$sizes.Count
for($i=0;$i -lt $sizes.Count;$i++){
  $s=$sizes[$i]; $len=$blobs[$i].Length
  $dim=[byte]0; if($s -lt 256){ $dim=[byte]$s }
  $hdr=New-Object System.Collections.Generic.List[byte]
  $hdr.Add($dim); $hdr.Add($dim); $hdr.Add([byte]0); $hdr.Add([byte]0)
  $hdr.AddRange([System.BitConverter]::GetBytes([UInt16]1))
  $hdr.AddRange([System.BitConverter]::GetBytes([UInt16]32))
  $hdr.AddRange([System.BitConverter]::GetBytes([UInt32]$len))
  $hdr.AddRange([System.BitConverter]::GetBytes([UInt32]$offset))
  $out.AddRange($hdr)
  $offset += $len
}
foreach($b in $blobs){ $out.AddRange([byte[]]$b) }
$bytes=$out.ToArray()
Write-Output ('ico bytes=' + $bytes.Length)
[System.IO.File]::WriteAllBytes((Join-Path $iconDir 'icon.ico'), $bytes)
Write-Output ('written=' + (Get-Item (Join-Path $iconDir 'icon.ico')).Length)
$source.Dispose()