# PowerShell script to close unprotected stock positions (no OCO sell orders)
# Run from project root: .\scripts\close-unprotected-positions.ps1

Write-Host "🔍 Checking for unprotected stock positions..." -ForegroundColor Cyan
Write-Host "================================================" -ForegroundColor Cyan
Write-Host ""

$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location "$scriptPath\.."

npx ts-node src/modules/alpaca-paper-trading/scripts/close-unprotected-positions.ts
