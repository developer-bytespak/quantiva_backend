@echo off
REM Batch launcher: activates venv (if present) and runs run.py
if exist venv312\Scripts\activate.bat (
  call venv312\Scripts\activate.bat
  python run.py
) else (
  echo venv312 not found. Running setup script...
  echo.
  call setup.bat
  if errorlevel 1 (
    echo Setup failed. Please run setup.bat manually.
    pause
    exit /b 1
  )
  echo.
  echo Starting application...
  python run.py
)
pause
