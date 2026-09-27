$ErrorActionPreference = "Stop"

$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktopResources = Join-Path $workspace "apps\desktop\src-tauri\resources"
$serverResources = Join-Path $desktopResources "server"
$nodeSource = (Get-Command node -ErrorAction Stop).Source
function Get-RuntimeHash([string]$path) {
  $stream = [System.IO.File]::OpenRead($path)
  $hash = [System.Security.Cryptography.SHA256]::Create()
  try { return [System.BitConverter]::ToString($hash.ComputeHash($stream)) }
  finally { $hash.Dispose(); $stream.Dispose() }
}

Write-Host "Building local API..."
pnpm --filter @nexious/server build
if ($LASTEXITCODE -ne 0) { throw "Local API build failed." }

if (Test-Path -LiteralPath $serverResources) {
  $resolvedResources = (Resolve-Path -LiteralPath $serverResources).Path
  $expectedResources = [System.IO.Path]::GetFullPath((Join-Path $workspace "apps\desktop\src-tauri\resources\server"))
  if ($resolvedResources -ne $expectedResources) { throw "Unexpected runtime resource directory: $resolvedResources" }
  Remove-Item -LiteralPath $serverResources -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $serverResources "dist") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $serverResources "src") -Force | Out-Null

$nodeDestination = Join-Path $desktopResources "node.exe"
if (!(Test-Path -LiteralPath $nodeDestination) -or (Get-RuntimeHash $nodeSource) -ne (Get-RuntimeHash $nodeDestination)) {
  Copy-Item -LiteralPath $nodeSource -Destination $nodeDestination -Force
}
Copy-Item -Path (Join-Path $workspace "apps\server\dist\*") -Destination (Join-Path $serverResources "dist") -Recurse -Force
Copy-Item -Path (Join-Path $workspace "apps\server\src\*.ts") -Destination (Join-Path $serverResources "src") -Force

# Use a standalone install so the resource directory contains no workspace links.
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
    mysql2 = "^3.24.4"
  }
} | ConvertTo-Json -Depth 5
$packagePath = Join-Path $serverResources "package.json"
[System.IO.File]::WriteAllText($packagePath, $package, [System.Text.UTF8Encoding]::new($false))
pnpm install --dir $serverResources --prod --ignore-scripts --ignore-workspace --config.node-linker=hoisted
if ($LASTEXITCODE -ne 0) { throw "Local API dependency installation failed." }

Write-Host "Local API runtime resources prepared."
