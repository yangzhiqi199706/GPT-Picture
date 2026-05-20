@echo off
title GPT-Image-2 Test Console
cd /d "%~dp0"

echo.
echo ============================================
echo   GPT-Image-2 Test Console - Launcher
echo ============================================
echo.

rem ---------- Check Node ----------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo.
    echo Please install Node.js LTS:
    echo   https://nodejs.org/
    echo.
    echo After install, double-click this file again.
    echo.
    pause
    exit /b 1
)

rem ---------- Check server.js ----------
if not exist "server.js" (
    echo [ERROR] server.js not found in current directory.
    echo.
    echo Current dir: %CD%
    echo.
    pause
    exit /b 1
)

rem ---------- Auto-stop existing server (avoid leftover processes) ----------
if exist ".server.pid" (
    set /p OLD_PID=<.server.pid
    echo [INFO] Found leftover server, stopping it first...
    taskkill /F /PID %OLD_PID% >nul 2>nul
    del /q ".server.pid" 2>nul
    timeout /t 1 /nobreak >nul
)

rem ---------- Show Node version ----------
echo [OK] Node detected:
node --version
echo.
echo [OK] Starting local server with API reverse proxy...
echo.
echo   URL:    http://localhost:3000
echo   Stop:   Ctrl+C  OR  double-click stop.bat
echo.

rem Open browser after 2s (give server time to listen)
start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

rem ---------- Run server ----------
node server.js
set EXITCODE=%errorlevel%

rem ---------- Cleanup PID file ----------
if exist ".server.pid" del /q ".server.pid" 2>nul

rem ---------- Show error if abnormal exit ----------
echo.
echo ============================================
if "%EXITCODE%"=="0" (
    echo   Server exited normally.
) else (
    echo   [ERROR] Server crashed. Exit code: %EXITCODE%
    echo.
    echo   Common causes:
    echo   1. Port 3000 already in use
    echo      ^=^> Close the program using it, or run: node server.js 3001
    echo   2. Firewall / antivirus blocking node.exe
    echo      ^=^> Add node.exe to whitelist
    echo   3. server.js corrupted
    echo      ^=^> Ask AI to regenerate
    echo.
    echo   Run "diagnose.bat" for auto check.
)
echo ============================================
echo.
pause
