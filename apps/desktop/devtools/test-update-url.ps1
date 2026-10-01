$p1 = & curl.exe -sS --ssl-no-revoke --connect-timeout 6 --max-time 12 'https://gh-proxy.com/https://raw.githubusercontent.com/TensorHub-ORG/Coomi/refs/heads/coomi-desktop/windows/latest.json' 2>&1
Write-Output ('PROXY_BODY=' + ($p1 -join ''))
$p2 = & curl.exe -sS --ssl-no-revoke --connect-timeout 6 --max-time 12 'https://raw.githubusercontent.com/TensorHub-ORG/Coomi/refs/heads/coomi-desktop/windows/latest.json' 2>&1
Write-Output ('DIRECT_BODY=' + ($p2 -join ''))