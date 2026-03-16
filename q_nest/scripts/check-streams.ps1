#!/usr/bin/env pwsh
# check-streams.ps1
# Quick check: are both Binance WebSocket streams alive?
# Usage: .\scripts\check-streams.ps1 [base_url]
# Default base_url: http://localhost:3000

param(
  [string]$BaseUrl = "http://localhost:3000"
)

Write-Host ""
Write-Host "=== Binance Stream Health Check ===" -ForegroundColor Cyan
Write-Host "Target: $BaseUrl"
Write-Host ""

try {
  $response = Invoke-RestMethod -Uri "$BaseUrl/admin/binance/health" -Method GET -TimeoutSec 5
} catch {
  Write-Host "ERROR: Could not reach server -- is it running?" -ForegroundColor Red
  Write-Host $_.Exception.Message
  exit 1
}

# Market Data Stream
$ms = $response.marketStream
if ($ms.connected) {
  $msStatus = "CONNECTED [OK]"
  $msColor  = "Green"
} else {
  $msStatus = "DISCONNECTED [FAIL]"
  $msColor  = "Red"
}

Write-Host "--- Market Data Stream (BinanceMarketStreamService) ---" -ForegroundColor Yellow
Write-Host "Status      : $msStatus" -ForegroundColor $msColor
Write-Host "Symbols     : $($ms.symbolsTracked) tickers cached"
Write-Host "BTC price   : $(if ($null -ne $ms.samplePrices.BTCUSDT) { $ms.samplePrices.BTCUSDT } else { 'N/A' })"
Write-Host "ETH price   : $(if ($null -ne $ms.samplePrices.ETHUSDT) { $ms.samplePrices.ETHUSDT } else { 'N/A' })"
Write-Host "BNB price   : $(if ($null -ne $ms.samplePrices.BNBUSDT) { $ms.samplePrices.BNBUSDT } else { 'N/A' })"
Write-Host ""

# User Data Stream
$us = $response.userDataStream
if ($us.activeConnections -gt 0) {
  $usColor = "Green"
} else {
  $usColor = "DarkGray"
}

Write-Host "--- User Data Stream (BinanceUserWsService) ---" -ForegroundColor Yellow
Write-Host "Active user connections: $($us.activeConnections)" -ForegroundColor $usColor
if ($us.activeConnections -eq 0) {
  Write-Host "(Normal when no user has opened the account-stream socket yet)" -ForegroundColor DarkGray
}
Write-Host ""

# Summary
Write-Host "Timestamp: $($response.timestamp)"
Write-Host ""

if (-not $ms.connected) {
  Write-Host "FAIL: Market stream is not connected. Check backend logs for 'Ticker stream error'." -ForegroundColor Red
  exit 1
} elseif ($ms.symbolsTracked -eq 0) {
  Write-Host "WARN: Stream connected but no tickers cached yet -- wait a few seconds and retry." -ForegroundColor Yellow
  exit 1
} else {
  Write-Host "All streams OK." -ForegroundColor Green
  exit 0
}
