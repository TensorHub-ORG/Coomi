$h = "Authorization: Bearer $env:GH_TOKEN"
$api = "https://api.github.com"
$full = & curl.exe -sS --ssl-no-revoke -w "`nHTTP=%{http_code}" -X POST -H $h -H "Content-Type: application/json" --data-binary @G:/coomi-updates-repo.json "$api/user/repos" 2>&1 | Out-String
Write-Output $full.Trim()