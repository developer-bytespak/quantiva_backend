# PowerShell launcher: activates venv for this session then runs run.py
param()

$venv = Join-Path $PSScriptRoot 'venv312\Scripts\Activate.ps1'
if (Test-Path $venv) {
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
    & $venv
    python run.py
} else {
    Write-Host "venv312 not found. Running setup script..." -ForegroundColor Yellow
    Write-Host ""
    & "$PSScriptRoot\setup.ps1"
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "Starting application..." -ForegroundColor Green
        python run.py
    } else {
        Write-Host "Setup failed. Please run .\setup.ps1 manually." -ForegroundColor Red
        exit 1
    }
}
