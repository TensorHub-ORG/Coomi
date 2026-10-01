$dst = 'C:/Users/Monai-Bob/Desktop/Coomi_0.9.7_x64-setup.exe'
$sha = (Get-FileHash $dst -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item $dst).Length
$j = '{"code":197,"name":"Beta0.9.7","url":"https://raw.githubusercontent.com/TensorHub-ORG/Coomi/refs/heads/coomi-desktop/windows/Coomi_0.9.7_x64-setup.exe","size":' + $size + ',"sha256":"' + $sha + '","channel":"beta"}'
[IO.File]::WriteAllText('G:/coomi-updates/windows/latest.json', $j, (New-Object System.Text.UTF8Encoding($false)))
Set-Location 'G:/coomi-updates'
git add -A
git -c user.email=u@c -c user.name=u commit -q -m 'url refs/heads/main' 2>&1 | Out-String | ForEach-Object { Write-Output $_ }
git push -q origin main 2>&1 | Out-String | ForEach-Object { Write-Output $_ }
$man = & curl.exe -sS --ssl-no-revoke "https://raw.githubusercontent.com/TensorHub-ORG/Coomi/refs/heads/coomi-desktop/windows/latest.json" 2>&1 | Out-String
Write-Output ("MANIFEST=" + $man.Trim())
$head = & curl.exe -sS --ssl-no-revoke -I -w "HTTP=%{http_code} size=%{size_download}" "https://raw.githubusercontent.com/TensorHub-ORG/Coomi/refs/heads/coomi-desktop/windows/Coomi_0.9.7_x64-setup.exe" 2>&1 | Out-String
Write-Output ("EXE_HEAD=" + ($head.Trim() -split "`n" | Select-Object -Last 1))