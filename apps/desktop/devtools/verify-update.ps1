$h = "Authorization: Bearer $env:GH_TOKEN"
$api = "https://api.github.com"
$c = & curl.exe -sS --ssl-no-revoke -H $h "$api/repos/TensorHub-ORG/Coomi/contents/windows/latest.json?ref=main" 2>&1 | Out-String
Write-Output ("API_MAIN=" + $c.Trim().Substring(0,[Math]::Min(140,$c.Trim().Length)))
Start-Sleep -Seconds 3
$raw = & curl.exe -sS --ssl-no-revoke -w "`nHTTP=%{http_code}" "https://raw.githubusercontent.com/TensorHub-ORG/Coomi/main/windows/latest.json?v=2" 2>&1 | Out-String
Write-Output ("RAW2=" + $raw.Trim().Substring(0,[Math]::Min(240,$raw.Trim().Length)))