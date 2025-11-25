@echo off
REM Batch launcher: activates venv (if present) and runs run.py
if exist .venv\Scripts\activate.bat (
  call .venv\Scripts\activate.bat
)
python run.py
pause
