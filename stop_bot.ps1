# stop_bot.ps1
# Stops the background trading bot launched by start_bot_background.ps1.

$here    = Split-Path -Parent $MyInvocation.MyCommand.Definition
$pidFile = Join-Path $here 'logs\bot.pid'

if (!(Test-Path $pidFile)) {
    Write-Host "No PID file found at $pidFile. Is the bot running?" -ForegroundColor Yellow
    exit 0
}

$botPid = Get-Content $pidFile -ErrorAction SilentlyContinue
if (-not $botPid) {
    Write-Host "PID file empty — removing." -ForegroundColor Yellow
    Remove-Item $pidFile -Force
    exit 0
}

$proc = Get-Process -Id $botPid -ErrorAction SilentlyContinue
if ($proc) {
    Write-Host "Stopping bot (PID $botPid, process $($proc.ProcessName))..." -ForegroundColor Cyan
    Stop-Process -Id $botPid -Force
    Start-Sleep -Seconds 1
    Write-Host "Stopped." -ForegroundColor Green
} else {
    Write-Host "PID $botPid is no longer running." -ForegroundColor Yellow
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
