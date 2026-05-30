@echo off
REM Double-click this file to start the trading bot HIDDEN in the background.
REM It will keep running until you reboot or run stop_bot.ps1.
REM Logs are written to logs\bot.log in this folder.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_bot_background.ps1"
pause
