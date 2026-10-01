$h = "Authorization: Bearer $env:GH_TOKEN"
$api = "https://api.github.com"
$c = & curl.exe -sS --ssl-no-revoke -H $h "$api/repos/TensorHub-ORG/Coomi/contents/windows/latest.json?ref=main" 2>&1 | Out-String
$obj = $c | ConvertFrom-Json
$txt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($obj.content))
Write-Output ("CURRENT=" + $txt)
$wanted = '{"code":197,"name":"Beta0.9.7","url":"https://raw.githubusercontent.com/TensorHub-ORG/Coomi/refs/heads/coomi-desktop/windows/Coomi_0.9.7_x64-setup.exe","size":42245700,"sha256":"1c422c3008fa6b84f53a2340a7c18432887d12ab39e747b2728ec4dc22e3a882","channel":"beta"}'
if ($txt.Trim() -ne $wanted) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($wanted))
  $body = ('{"message":"url refs/heads","content":"' + $b64 + '","sha":"' + $obj.sha + '"}')
  [IO.File]::WriteAllText('G:/coomi-updates-body.json', $body, (New-Object System.Text.UTF8Encoding($false)))
  $put = & curl.exe -sS --ssl-no-revoke -X PUT -H $h -H "Content-Type: application/json" --data-binary @G:/coomi-updates-body.json "$api/repos/TensorHub-ORG/Coomi/contents/windows/latest.json" 2>&1 | Out-String
  Write-Output ("PUT=" + $put.Trim().Substring(0,[Math]::Min(100,$put.Trim().Length)))
  Start-Sleep -Seconds 2
} else { Write-Output 'ALREADY_CORRECT' }
$c2 = & curl.exe -sS --ssl-no-revoke -H $h "$api/repos/TensorHub-ORG/Coomi/contents/windows/latest.json?ref=main" 2>&1 | Out-String
$obj2 = $c2 | ConvertFrom-Json
$txt2 = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($obj2.content))
Write-Output ("FINAL=" + $txt2)