# Re-enable the daily check-in polling task (run by DSH-CheckinReset at 00:05).
$ErrorActionPreference = 'SilentlyContinue'
cmd /c "schtasks /change /tn DSH-DailyCheckin /enable >nul 2>&1"