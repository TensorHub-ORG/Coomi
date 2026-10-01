$dir = 'G:/DSH/coomi-full-project/docs/plugins/dsh-deep-whale'
$enc = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText("$dir/theme.json", $args[0], $enc)
$zip = 'C:/Users/Monai-Bob/Desktop/dsh-deep-whale.zip'
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$dir/*" -DestinationPath $zip -Force
Write-Output ('ZIP=' + $zip + ' SIZE=' + (Get-Item $zip).Length)