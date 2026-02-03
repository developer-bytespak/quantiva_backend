#!/usr/bin/env pwsh
# Script to test auto-trading cron jobs manually

$BackendUrl = "http://localhost:3000"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "🤖 Testing Auto-Trading Cron Jobs" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if backend is running
Write-Host "📡 Checking if backend is running..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "$BackendUrl/health" -Method GET -TimeoutSec 5 -ErrorAction Stop
    Write-Host "✓ Backend is running" -ForegroundColor Green
} catch {
    Write-Host "✗ Backend is not running at $BackendUrl" -ForegroundColor Red
    Write-Host "  Start the backend first: cd quantiva_backend/q_nest && npm run start:dev" -ForegroundColor Yellow
    exit 1
}

Write-Host ""

# Check Alpaca auto-trading status
Write-Host "📊 Checking Alpaca auto-trading status..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$BackendUrl/api/alpaca-paper-trading/auto-trading/status" -Method GET
    Write-Host "Session Status: $($response.session.status)" -ForegroundColor Cyan
    Write-Host "Session ID: $($response.session.sessionId)" -ForegroundColor Cyan
    Write-Host "Total Trades: $($response.session.stats.totalTrades)" -ForegroundColor Cyan
    Write-Host "Today's Trades: $($response.session.stats.todayTrades)" -ForegroundColor Cyan
} catch {
    Write-Host "✗ Failed to get Alpaca status: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""

# Check Binance auto-trading status
Write-Host "🪙 Checking Binance crypto auto-trading status..." -ForegroundColor Yellow
try {
    $response = Invoke-RestMethod -Uri "$BackendUrl/api/binance-testnet/auto-trading/status" -Method GET
    Write-Host "Session Status: $($response.session.status)" -ForegroundColor Cyan
    Write-Host "Session ID: $($response.session.sessionId)" -ForegroundColor Cyan
    Write-Host "Total Trades: $($response.session.stats.totalTrades)" -ForegroundColor Cyan
    Write-Host "Today's Trades: $($response.session.stats.todayTrades)" -ForegroundColor Cyan
} catch {
    Write-Host "✗ Failed to get Binance status: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Options:" -ForegroundColor Cyan
Write-Host "1. Trigger Alpaca auto-trade manually" -ForegroundColor White
Write-Host "2. Trigger Binance crypto auto-trade manually" -ForegroundColor White
Write-Host "3. View logs" -ForegroundColor White
Write-Host "4. Exit" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$choice = Read-Host "Enter your choice (1-4)"

switch ($choice) {
    "1" {
        Write-Host ""
        Write-Host "🚀 Triggering Alpaca auto-trade execution..." -ForegroundColor Green
        try {
            $response = Invoke-RestMethod -Uri "$BackendUrl/api/alpaca-paper-trading/auto-trading/execute" -Method POST
            Write-Host "✓ Execution complete" -ForegroundColor Green
            Write-Host "Success: $($response.success)" -ForegroundColor Cyan
            Write-Host "Trades Executed: $($response.tradesExecuted)" -ForegroundColor Cyan
            if ($response.errors.Count -gt 0) {
                Write-Host "Errors: $($response.errors -join ', ')" -ForegroundColor Red
            }
        } catch {
            Write-Host "✗ Failed: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    "2" {
        Write-Host ""
        Write-Host "🚀 Triggering Binance crypto auto-trade execution..." -ForegroundColor Green
        try {
            $response = Invoke-RestMethod -Uri "$BackendUrl/api/binance-testnet/auto-trading/execute" -Method POST
            Write-Host "✓ Execution complete" -ForegroundColor Green
            Write-Host "Success: $($response.success)" -ForegroundColor Cyan
            Write-Host "Trades Executed: $($response.tradesExecuted)" -ForegroundColor Cyan
            if ($response.errors.Count -gt 0) {
                Write-Host "Errors: $($response.errors -join ', ')" -ForegroundColor Red
            }
        } catch {
            Write-Host "✗ Failed: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
    "3" {
        Write-Host ""
        Write-Host "📋 Recent logs (last 50 lines):" -ForegroundColor Yellow
        Get-Content "../logs/*.log" -Tail 50 -ErrorAction SilentlyContinue | Out-Host
    }
    "4" {
        Write-Host "Goodbye!" -ForegroundColor Green
        exit 0
    }
    default {
        Write-Host "Invalid choice" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Press any key to exit..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
