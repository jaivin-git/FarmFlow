@echo off
title FarmFlow - Solar Irrigation Simulator
echo ========================================================
echo   Starting FarmFlow Solar Irrigation Simulator v3...
echo ========================================================
echo.
cd /d "%~dp0"

:: Check if node is available
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not found in PATH!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

:: Clean previous active port file
if exist active_port.txt del active_port.txt

:: Start Node.js server in a separate background console window
echo Starting FarmFlow backend server...
start "FarmFlow Server (Keep Open)" cmd /k "title FarmFlow Server Console && echo ======================================================== && echo   FarmFlow Backend Server v3 is Running! && echo   Data directory: %~dp0data && echo   Do NOT close this window while using the application. && echo ======================================================== && echo. && node server.js"

:: Wait 2 seconds for server to initialize and write active_port.txt
timeout /t 2 /nobreak >nul

set TARGET_PORT=3001
if exist active_port.txt (
    set /p TARGET_PORT=<active_port.txt
)

echo Opening FarmFlow on http://localhost:%TARGET_PORT% in your default browser...
start http://localhost:%TARGET_PORT%

echo.
echo ========================================================
echo   FarmFlow has been opened in your browser!
echo   Active Website URL: http://localhost:%TARGET_PORT%
echo ========================================================
timeout /t 3 /nobreak >nul
exit
