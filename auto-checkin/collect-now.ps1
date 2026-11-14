# One-minute tick for DSH-CreditCollect: collect balances only when the board
# service drops logs\refresh.flag. Runs inside a Calendar-triggered task context,
# which is the proven-reliable place to launch the GUI clients.
# ASCII-only on purpose: PowerShell 5.1 reads UTF-8-without-BOM files as ANSI.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$flag = Join-Path $root 'logs\refresh.flag'
if (-not (Test-Path $flag)) { exit 0 }
Remove-Item $flag -Force -ErrorAction SilentlyContinue
& (Join-Path $root 'collect.ps1')
exit $LASTEXITCODE
