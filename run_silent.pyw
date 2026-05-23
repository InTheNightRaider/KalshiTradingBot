"""
run_silent.pyw
==============
Windowless launcher for master_bot.py.
Double-click this file, or run: pythonw run_silent.pyw

All output (trades, errors, cycle logs) is written to bot_log.txt
in the same folder so you can check it anytime.
"""
import sys, os

# Point working directory to this file's folder
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Redirect all output to bot_log.txt (line-buffered so it flushes in real time)
log = open("bot_log.txt", "a", buffering=1, encoding="utf-8")
sys.stdout = log
sys.stderr = log

# Stamp the log with a start time
from datetime import datetime
print("\n" + "="*64)
print(f"  BOT STARTED: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
print("="*64)

# Run the bot
import master_bot
master_bot.run()
