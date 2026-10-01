$h = "Authorization: Bearer $env:GH_TOKEN"
[IO.File]::WriteAllText('G:/coomi-updates-def.json', '{"default_branch":"main"}', (New-Object System.Text.UTF8Encoding($false)))
$p = & curl.exe -sS --ssl-no-revoke -X PATCH -H $h -H "Content-Type: application/json" --data-binary @G:/coomi-updates-def.json "https://api.github.com/repos/TensorHub-ORG/Coomi" 2>&1 | Out-String
Write-Output ("DEFAULT=" + $p.Trim().Substring(0,[Math]::Min(80,$p.Trim().Length)))
Start-Sleep -Seconds 5
$r1 = & curl.exe -sS --ssl-no-revoke -w "`nHTTP=%{http_code}" "https://raw.githubusercontent.com/TensorHub-ORG/Coomi/main/windows/latest.json" 2>&1 | Out-String
Write-Output ("RAW_MAIN=" + $r1.Trim().Substring(0,[Math]::Min(200,$r1.Trim().Length)))
$r2 = & curl.exe -sS --ssl-no-revoke -w "`nHTTP=%{http_code}" "https://raw.githubusercontent.com/TensorHub-ORG/Coomi/refs/heads/coomi-desktop/windows/latest.json" 2>&1 | Out-String
Write-Output ("RAW_REF=" + $r2.Trim().Substring(0,[Math]::Min(200,$r2.Trim().Length)))