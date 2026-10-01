$ErrorActionPreference = "Continue"
$h = "Authorization: Bearer $env:GH_TOKEN"
$api = "https://api.github.com"
$repo = "TensorHub-ORG/Coomi"
[IO.File]::WriteAllText('G:/coomi-updates-repo.json', '{"name":"coomi-updates","private":true,"description":"Coomi update channel"}', (New-Object System.Text.UTF8Encoding($false)))
$c1 = & curl.exe -sS --ssl-no-revoke -X POST -H $h -H "Content-Type: application/json" -d "@G:/coomi-updates-repo.json" "$api/user/repos" 2>&1 | Out-String
Write-Output ("REPO=" + $c1.Trim().Substring(0,[Math]::Min(160,$c1.Trim().Length)))
$who = & curl.exe -sS --ssl-no-revoke -H $h "$api/user" 2>&1 | Out-String
Write-Output ("WHO=" + $who.Trim().Substring(0,[Math]::Min(80,$who.Trim().Length)))
Set-Location 'G:/coomi-updates'
git remote remove origin 2>$null | Out-Null
git remote add origin "https://x-access-token:$env:GH_TOKEN@github.com/TensorHub-ORG/Coomi.git"
git push -q -u origin master 2>&1 | Out-String | ForEach-Object { Write-Output $_ }
Write-Output 'PUSH_DONE'