Set-Location 'G:/coomi-updates'
git remote remove origin 2>$null | Out-Null
git remote add origin "https://x-access-token:$env:GH_TOKEN@github.com/TensorHub-ORG/Coomi.git"
git push -q -u origin master 2>&1 | Out-String | ForEach-Object { Write-Output $_ }
$c = & curl.exe -sS --ssl-no-revoke -H "Authorization: Bearer $env:GH_TOKEN" "https://api.github.com/repos/TensorHub-ORG/Coomi/contents/windows/latest.json" 2>&1 | Out-String
Write-Output ("LATEST_JSON_CHECK=" + $c.Trim().Substring(0,[Math]::Min(150,$c.Trim().Length)))