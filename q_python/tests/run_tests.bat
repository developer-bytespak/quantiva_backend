@echo off
REM Batch script to run news API tests on Windows

echo ================================================================================
echo News API Test Runner
echo ================================================================================
echo.

cd /d "%~dp0\.."

echo Checking environment variables...
if "%LUNARCRUSH_API_KEY%"=="" (
    echo WARNING: LUNARCRUSH_API_KEY is not set
) else (
    echo OK: LUNARCRUSH_API_KEY is set
)

if "%STOCK_NEWS_API_KEY%"=="" (
    echo WARNING: STOCK_NEWS_API_KEY is not set
) else (
    echo OK: STOCK_NEWS_API_KEY is set
)

echo.
echo ================================================================================
echo Running combined test script...
echo ================================================================================
echo.

python tests\test_news_apis.py

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ================================================================================
    echo Tests completed successfully!
    echo ================================================================================
) else (
    echo.
    echo ================================================================================
    echo Tests completed with errors. Check output above.
    echo ================================================================================
)

pause

