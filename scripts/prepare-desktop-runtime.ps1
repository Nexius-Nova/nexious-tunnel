$ErrorActionPreference = "Stop"

$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktopResources = Join-Path $workspace "apps\desktop\src-tauri\resources"
$serverResources = Join-Path $desktopResources "server"
$nodeSource = (Get-Command node -ErrorAction Stop).Source

Write-Host "Building local API..."
pnpm --filter @nexious/server build

if (Test-Path -LiteralPath $desktopResources) {
  Remove-Item -LiteralPath $desktopResources -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $serverResources "dist") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $serverResources "src") -Force | Out-Null

Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $desktopResources "node.exe") -Force
Copy-Item -Path (Join-Path $workspace "apps\server\dist\*") -Destination (Join-Path $serverResources "dist") -Recurse -Force
Copy-Item -Path (Join-Path $workspace "apps\server\src\*.ts") -Destination (Join-Path $serverResources "src") -Force

# Use a standalone npm install so the resource directory contains no workspace links.
$package = @{
  name = "nexious-local-api"
  private = $true
  type = "module"
  dependencies = @{
    cors = "^2.8.5"
    express = "^5.1.0"
    ssh2 = "^1.17.0"
    ws = "^8.18.0"
    zod = "^3.24.2"
  }
} | ConvertTo-Json -Depth 5
$packagePath = Join-Path $serverResources "package.json"
[System.IO.File]::WriteAllText($packagePath, $package, [System.Text.UTF8Encoding]::new($false))
npm install --prefix $serverResources --omit=optional --ignore-scripts --no-audit --no-fund
Remove-Item -LiteralPath $packagePath -Force

Write-Host "Local API runtime resources prepared."
