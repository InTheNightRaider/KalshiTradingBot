# start_bot_background.ps1
# Launches kalshi_btc_paper_bot.js in a hidden window so it keeps trading
# while you do other work. Output is appended to logs\bot.log.
#
# Usage (from PowerShell in the project folder):
#   .\start_bot_background.ps1
#
# Or just double-click start_bot.bat
#
# To stop the bot later, run:
#   .\stop_bot.ps1

$ErrorActionPreference = 'Stop'

$here    = Split-Path -Parent $MyInvocation.MyCommand.Definition
$apiKey  = 'e2475509-4a0c-4beb-9d45-be55a920d057'
$logsDir = Join-Path $here 'logs'
$logFile = Join-Path $logsDir 'bot.log'
$errFile = Join-Path $logsDir 'bot.err.log'
$pidFile = Join-Path $logsDir 'bot.pid'

if (!(Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }

# If a pid file exists and that process is still alive, refuse to start a duplicate.
if (Test-Path $pidFile) {
    $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($oldPid) {
        $existing = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($existing -and $existing.ProcessName -match 'node') {
            Write-Host "Bot already running (PID $oldPid). Run .\stop_bot.ps1 first." -ForegroundColor Yellow
            exit 1
        }
    }
}

# Rotate previous log if it's larger than 5 MB.
if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 5MB)) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Rename-Item $logFile (Join-Path $logsDir "bot.$stamp.log")
}

# Launch the bot hidden. stdout -> bot.log, stderr -> bot.err.log
$proc = Start-Process `
    -FilePath 'node' `
    -ArgumentList @('kalshi_btc_paper_bot.js', $apiKey, '--live') `
    -WorkingDirectory $here `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError $errFile `
    -PassThru

Set-Content -Path $pidFile -Value $proc.Id

Write-Host "Bot started in background." -ForegroundColor Green
Write-Host "  PID:    $($proc.Id)"
Write-Host "  Logs:   $logFile"
Write-Host "  Errors: $errFile"
Write-Host ""
Write-Host "Tail live with:" -ForegroundColor Cyan
Write-Host "  Get-Content $logFile -Wait -Tail 50"
Write-Host ""
Write-Host "Stop it with:" -ForegroundColor Cyan
Write-Host "  .\stop_bot.ps1"
