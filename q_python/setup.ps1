# PowerShell setup script: Creates venv, installs dependencies, and activates it
param()

$ErrorActionPreference = "Stop"

Write-Host "=== Python Virtual Environment Setup ===" -ForegroundColor Cyan
Write-Host ""

# Check if Python is installed
Write-Host "Checking Python installation..." -ForegroundColor Yellow
try {
    $pythonVersion = python --version 2>&1
    Write-Host "Found: $pythonVersion" -ForegroundColor Green
    
    # Check if Python version is 3.12 or higher
    $versionMatch = $pythonVersion -match "Python (\d+)\.(\d+)"
    if ($versionMatch) {
        $majorVersion = [int]$matches[1]
        $minorVersion = [int]$matches[2]
        
        if ($majorVersion -lt 3 -or ($majorVersion -eq 3 -and $minorVersion -lt 12)) {
            Write-Host "Warning: Python 3.12+ is recommended. Current version: $pythonVersion" -ForegroundColor Yellow
        }
    }
} catch {
    Write-Host "Error: Python is not installed or not in PATH" -ForegroundColor Red
    Write-Host "Please install Python 3.12+ from https://www.python.org/downloads/" -ForegroundColor Yellow
    exit 1
}

# Check if venv312 already exists
$venvPath = Join-Path $PSScriptRoot "venv312"
$venvActivate = Join-Path $venvPath "Scripts\Activate.ps1"

if (Test-Path $venvPath) {
    Write-Host "Virtual environment 'venv312' already exists." -ForegroundColor Green
} else {
    Write-Host "Creating virtual environment 'venv312'..." -ForegroundColor Yellow
    python -m venv venv312
    
    if (-not (Test-Path $venvPath)) {
        Write-Host "Error: Failed to create virtual environment" -ForegroundColor Red
        exit 1
    }
    Write-Host "Virtual environment created successfully!" -ForegroundColor Green
}

# Activate the virtual environment
Write-Host ""
Write-Host "Activating virtual environment..." -ForegroundColor Yellow
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
& $venvActivate

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Failed to activate virtual environment" -ForegroundColor Red
    exit 1
}

# Upgrade pip
Write-Host ""
Write-Host "Upgrading pip..." -ForegroundColor Yellow
python -m pip install --upgrade pip --quiet

if ($LASTEXITCODE -ne 0) {
    Write-Host "Warning: Failed to upgrade pip. Continuing anyway..." -ForegroundColor Yellow
}

# Install dependencies
Write-Host ""
Write-Host "Installing dependencies from requirements/base.txt..." -ForegroundColor Yellow
$requirementsPath = Join-Path $PSScriptRoot "requirements\base.txt"

if (-not (Test-Path $requirementsPath)) {
    Write-Host "Error: requirements/base.txt not found!" -ForegroundColor Red
    exit 1
}

pip install -r $requirementsPath

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Failed to install dependencies" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Setup Complete! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Virtual environment 'venv312' is now active." -ForegroundColor Cyan
Write-Host "You can now run the application with: python run.py" -ForegroundColor Cyan
Write-Host ""
Write-Host "To activate this environment in a new terminal session, run:" -ForegroundColor Yellow
Write-Host "  .\venv312\Scripts\Activate.ps1" -ForegroundColor White
Write-Host ""

