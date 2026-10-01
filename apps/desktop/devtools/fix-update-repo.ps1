$h = "Authorization: Bearer $env:GH_TOKEN"
[IO.File]::WriteAllText('G:/coomi-updates-pub.json', '{"private":false}', (New-Object System.Text.UTF8Encoding($false)))
$p = & curl.exe -sS --ssl-no-revoke -X PATCH -H $h -H "Content-Type: application/json" --data-binary @G:/coomi-updates-pub.json "https://api.github.com/repos/TensorHub-ORG/Coomi" 2>&1 | Out-String
Write-Output ("PUBLIC=" + $p.Trim().Substring(0,[Math]::Min(80,$p.Trim().Length)))
Set-Location 'G:/coomi-updates'
git branch -M main 2>&1 | Out-Null
$dst = 'C:/Users/Monai-Bob/Desktop/Coomi_0.9.7_x64-setup.exe'
$sha = (Get-FileHash $dst -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item $dst).Length
$j = '{"code":197,"name":"Beta0.9.7","url":"https://raw.githubusercontent.com/TensorHub-ORG/Coomi/main/windows/Coomi_0.9.7_x64-setup.exe","size":' + $size + ',"sha256":"' + $sha + '","channel":"beta"}'
[IO.File]::WriteAllText('G:/coomi-updates/windows/latest.json', $j, (New-Object System.Text.UTF8Encoding($false)))
git add -A; git -c user.email=u@c -c user.name=u commit -q -m 'main+public'; git push -q -u origin main 2>&1 | Out-String | ForEach-Object { Write-Output $_ }
$raw = & curl.exe -sS --ssl-no-revoke -w "`nHTTP=%{http_code}" "https://raw.githubusercontent.com/TensorHub-ORG/Coomi/main/windows/latest.json" 2>&1 | Out-String
Write-Output ("RAW=" + $raw.Trim().Substring(0,[Math]::Min(220,$raw.Trim().Length)))