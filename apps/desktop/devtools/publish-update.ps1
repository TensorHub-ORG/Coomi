$ErrorActionPreference = "Continue"
$h = "Authorization: Bearer $env:GH_TOKEN"
$api = "https://api.github.com"
$repo = "TensorHub-ORG/Coomi"
[IO.File]::WriteAllText('G:/coomi-updates-repo.json', '{"name":"coomi-updates","private":true}', (New-Object System.Text.UTF8Encoding($false)))
$c1 = & curl.exe -sS --ssl-no-revoke -X POST -H $h -H "Content-Type: application/json" -d "@G:/coomi-updates-repo.json" "$api/user/repos" 2>&1 | Out-String
Write-Output ("REPO=" + $c1.Trim().Substring(0,[Math]::Min(160,$c1.Trim().Length)))
$dir = 'G:/coomi-updates/windows'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dst = 'C:/Users/Monai-Bob/Desktop/Coomi_0.9.7_x64-setup.exe'
Copy-Item $dst "$dir/Coomi_0.9.7_x64-setup.exe" -Force
$sha = (Get-FileHash "$dir/Coomi_0.9.7_x64-setup.exe" -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item "$dir/Coomi_0.9.7_x64-setup.exe").Length
$j = '{"code":197,"name":"Beta0.9.7","url":"https://raw.githubusercontent.com/TensorHub-ORG/Coomi/main/windows/Coomi_0.9.7_x64-setup.exe","size":' + $size + ',"sha256":"' + $sha + '","channel":"beta"}'
[IO.File]::WriteAllText("$dir/latest.json", $j, (New-Object System.Text.UTF8Encoding($false)))
Set-Location 'G:/coomi-updates'
git init -q 2>&1 | Out-Null
git add -A 2>&1 | Out-Null
git -c user.email=updates@coomi -c user.name=updates commit -q -m 'v0.9.7' 2>&1 | Out-Null
git remote remove origin 2>$null | Out-Null
git remote add origin "https://x-access-token:$env:GH_TOKEN@github.com/TensorHub-ORG/Coomi.git"
git push -q -u origin master 2>&1 | Out-String | ForEach-Object { Write-Output $_ }
Write-Output ('PUSH_DONE sha=' + $sha.Substring(0,12))