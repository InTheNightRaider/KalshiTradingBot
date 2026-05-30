@echo off
cd /d "%~dp0"

echo Stopping any existing bots...
taskkill /F /IM pythonw.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
timeout /t 1 >nul

REM ── Launch JS Mode 1 LIVE bot ───────────────────────────────────
echo Starting BTC Mode 1 live bot (JS)...
where node >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    start "BTC Mode 1 Live" node kalshi_btc_paper_bot.js e2475509-4a0c-4beb-9d45-be55a920d057 --live
    echo   [OK] BTC Mode 1 live bot started
) else (
    echo   [WARN] node.exe not found - BTC bot not started. Install Node.js from nodejs.org
)

timeout /t 2 >nul

REM ── Launch Python master bot (Sports/Econ/News paper) ───────────
REM Find pythonw.exe next to the python.exe the system knows about
for /f "tokens=*" %%i in ('where python 2^>nul') do (
    set PYTHONW=%%i
    goto found_python
)
:found_python
set PYTHONW=%PYTHONW:python.exe=pythonw.exe%

if exist "%PYTHONW%" (
    echo Starting Python master bot using %PYTHONW%
    start "" "%PYTHONW%" run_silent.pyw
    goto done
)

REM Fallback: common install paths
for %%P in (
    "%LOCALAPPDATA%\Programs\Python\Python314\pythonw.exe"
    "%LOCALAPPDATA%\Programs\Python\Python313\pythonw.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\pythonw.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\pythonw.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\pythonw.exe"
) do (
    if exist %%P (
        echo Starting Python master bot using %%P
        start "" %%P run_silent.pyw
        goto done
    )
)

echo ERROR: Could not find pythonw.exe. Running in visible window instead.
start "Kalshi Bot" python run_silent.pyw

:done
timeout /t 2 >nul
echo.
echo Done. Two bots running:
echo   1. BTC Mode 1 LIVE  - node kalshi_btc_paper_bot.js --live  (places real orders)
echo   2. Python master bot - Sports/Econ/News paper tracking
echo.
echo Check bot_log.txt for Python bot output.
echo The BTC bot window titled "BTC Mode 1 Live" shows its live output.
echo.
pause
