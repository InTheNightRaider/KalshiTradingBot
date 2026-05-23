@echo off
:: ============================================================
:: IBKR Multi-Asset RSI Bot Launcher
:: ============================================================
:: BEFORE RUNNING:
::   1. Open TWS or IB Gateway and log in
::   2. TWS: File > Global Config > API > Settings
::      - Enable "Active X and Socket Clients"
::      - Port: 7497 (paper) or 7496 (live)
::      - Uncheck "Read-Only API"
::   3. Make sure LIVE_TRADING = False in ibkr_config.py for paper mode
:: ============================================================

title IBKR RSI Bot (Paper Mode)

echo.
echo  ===================================================
echo   IBKR Multi-Asset RSI Bot
echo   Make sure TWS or IB Gateway is running first!
echo  ===================================================
echo.

:: Install dependencies if needed
echo [1/2] Checking dependencies...
pip install ib_insync pandas requests --quiet

echo [2/2] Starting bot...
echo.

python ibkr_bot.py

echo.
echo Bot stopped. Press any key to close.
pause >nul
