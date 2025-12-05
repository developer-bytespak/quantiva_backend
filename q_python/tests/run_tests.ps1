# PowerShell script to run news API tests on Windows

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "News API Test Runner" -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host ""

# Change to script directory
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptPath\..

Write-Host "Checking environment variables..." -ForegroundColor Yellow
if (-not $env:LUNARCRUSH_API_KEY) {
    Write-Host "WARNING: LUNARCRUSH_API_KEY is not set" -ForegroundColor Yellow
} else {
    Write-Host "OK: LUNARCRUSH_API_KEY is set" -ForegroundColor Green
}

if (-not $env:STOCK_NEWS_API_KEY) {
    Write-Host "WARNING: STOCK_NEWS_API_KEY is not set" -ForegroundColor Yellow
} else {
    Write-Host "OK: STOCK_NEWS_API_KEY is set" -ForegroundColor Green
}

Write-Host ""
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "Running combined test script..." -ForegroundColor Cyan
Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host ""

# Run the test script
python tests\test_news_apis.py

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "================================================================================" -ForegroundColor Green
    Write-Host "Tests completed successfully!" -ForegroundColor Green
    Write-Host "================================================================================" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "================================================================================" -ForegroundColor Red
    Write-Host "Tests completed with errors. Check output above." -ForegroundColor Red
    Write-Host "================================================================================" -ForegroundColor Red
}

Write-Host ""
Write-Host "Press any key to continue..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

