# One-minute tick for DSH-CheckinNow: run the check-in only when the board
# service (or the user) drops logs\force.flag. run-checkin.ps1 consumes the
# flag itself and honours -Force (skips the time gate).
# ASCII-only on purpose: PowerShell 5.1 reads UTF-8-without-BOM files as ANSI.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$flag = Join-Path $root 'logs\force.flag'
if (-not (Test-Path $flag)) { exit 0 }
& (Join-Path $root 'run-checkin.ps1') -Force
exit $LASTEXITCODE
