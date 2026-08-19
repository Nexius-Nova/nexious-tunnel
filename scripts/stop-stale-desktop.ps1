$target = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\apps\desktop\src-tauri\target\debug\nexious-tunnel.exe'))

Get-CimInstance Win32_Process |
  Where-Object {
    $_.ExecutablePath -eq $target -or
    ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*D:\nexious-tunnel*')
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
