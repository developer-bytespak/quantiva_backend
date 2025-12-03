@echo off
REM Batch setup script: Creates venv, installs dependencies, and activates it

echo === Python Virtual Environment Setup ===
echo.

REM Check if Python is installed
echo Checking Python installation...
python --version >nul 2>&1
if errorlevel 1 (
    echo Error: Python is not installed or not in PATH
    echo Please install Python 3.12+ from https://www.python.org/downloads/
    exit /b 1
)

python --version
echo.

REM Check if venv312 already exists
if exist "venv312" (
    echo Virtual environment 'venv312' already exists.
) else (
    echo Creating virtual environment 'venv312'...
    python -m venv venv312
    if errorlevel 1 (
        echo Error: Failed to create virtual environment
        exit /b 1
    )
    echo Virtual environment created successfully!
)

REM Activate the virtual environment
echo.
echo Activating virtual environment...
call venv312\Scripts\activate.bat

if errorlevel 1 (
    echo Error: Failed to activate virtual environment
    exit /b 1
)

REM Upgrade pip
echo.
echo Upgrading pip...
python -m pip install --upgrade pip --quiet

REM Install dependencies
echo.
echo Installing dependencies from requirements/base.txt...
if not exist "requirements\base.txt" (
    echo Error: requirements/base.txt not found!
    exit /b 1
)

pip install -r requirements\base.txt

if errorlevel 1 (
    echo Error: Failed to install dependencies
    exit /b 1
)

echo.
echo === Setup Complete! ===
echo.
echo Virtual environment 'venv312' is now active.
echo You can now run the application with: python run.py
echo.
echo To activate this environment in a new terminal session, run:
echo   venv312\Scripts\activate.bat
echo.

