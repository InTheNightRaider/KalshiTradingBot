@echo off
echo Stopping all Kalshi bots...
taskkill /F /IM pythonw.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
echo All bots stopped (pythonw + node).
pause
