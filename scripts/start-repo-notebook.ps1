$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$port = if ($env:PORT) { $env:PORT } else { "5188" }
$url = "http://127.0.0.1:$port/"
$api = "http://127.0.0.1:$port/api/notebook"

Set-Location $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is required to run Repo Notebook." -ForegroundColor Red
  Write-Host "Install Node.js, then run this file again."
  Read-Host "Press Enter to close"
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
  Write-Host "Installing project dependencies..."
  npm install
}

try {
  $res = Invoke-WebRequest -UseBasicParsing $api -TimeoutSec 1
  if ($res.StatusCode -eq 200) {
    Start-Process $url
    exit 0
  }
} catch {}

Start-Job -ScriptBlock {
  param($url, $api)
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $res = Invoke-WebRequest -UseBasicParsing $api -TimeoutSec 1
      if ($res.StatusCode -eq 200) {
        Start-Process $url
        break
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
} -ArgumentList $url, $api | Out-Null

npm run dev
