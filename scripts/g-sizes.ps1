$out = 'G:\DSH\coomi-full-project\scripts\g-sizes.txt'
Remove-Item $out -ErrorAction SilentlyContinue
foreach ($d in Get-ChildItem 'G:\' -Directory -Force -ErrorAction SilentlyContinue) {
  $sum = 0
  $lines = & robocopy $d.FullName 'G:\__rc_null__' /L /E /BYTES /NFL /NDL /NJH /R:0 /W:0 /XJ 2>$null
  foreach ($l in $lines) { if ($l -match '^\s*Bytes\s*:\s+(\d+)') { $sum = [int64]$Matches[1] } }
  Add-Content $out ("{0}\t{1}" -f $sum, $d.Name)
  Write-Output ("{0,10:N2} GB  {1}" -f ($sum/1GB), $d.Name)
}
Write-Output 'DONE'