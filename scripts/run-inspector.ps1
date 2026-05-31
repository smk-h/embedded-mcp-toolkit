# MCP Inspector launch script for embedded-mcp-toolkit
# Usage: .\scripts\run-inspector.ps1
#   Or via npm: npm run inspector

# Resolve project root (script is at <root>/scripts/run-inspector.ps1)
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $ProjectRoot

# Ensure node_modules/.bin is in PATH (needed when run standalone, npm run adds it automatically)
$env:PATH = "$ProjectRoot\node_modules\.bin;$env:PATH"

# Kill any previous MCP inspector processes holding ports 6274 / 6277
$MCP_PORTS = @(6274, 6277)
foreach ($port in $MCP_PORTS) {
    $pidOnPort = (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique
    if ($pidOnPort) {
        foreach ($procId in $pidOnPort) {
            Write-Host "Killing process PID=$procId on port $port..." -ForegroundColor Yellow
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
    }
}

$env:DEVICE            = "board-b"
$env:BOARD_CONFIG_PATH = "./.embedded/configs/config.yaml"
$env:LOG_SAVE          = "1"
$env:LOG_DIR           = "./.embedded/log"

Write-Host "=== MCP Inspector ===" -ForegroundColor Cyan
Write-Host "Project Root     : $ProjectRoot"
Write-Host "DEVICE           : $env:DEVICE"
Write-Host "BOARD_CONFIG_PATH: $env:BOARD_CONFIG_PATH"
Write-Host "LOG_SAVE         : $env:LOG_SAVE"
Write-Host "LOG_DIR          : $env:LOG_DIR"
Write-Host "====================" -ForegroundColor Cyan

mcp-inspector node bin/embedded-mcp-toolkit-cli.js

Pop-Location
