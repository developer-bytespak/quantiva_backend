# PowerShell launcher: activates venv for this session then runs run.py
param()

$venv = Join-Path $PSScriptRoot '.venv\Scripts\Activate.ps1'
if (Test-Path $venv) {
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
    & $venv
    python run.py
} else {
    Write-Host ".venv not found. Run: python -m venv .venv" -ForegroundColor Yellow
    python run.py
}
