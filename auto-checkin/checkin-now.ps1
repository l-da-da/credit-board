# Tick for DSH-CheckinNow: run the check-in as soon as the board service (or
# the user) drops logs\force.flag.
#
# The task itself is triggered once a minute, but a click on the panel should
# feel instant, so this script long-polls the flag for most of the minute
# (50s). Overlapping ticks are skipped by the task's IgnoreNew policy, and the
# flag is consumed by run-checkin.ps1, so a tick that arrives while a run is
# still going just idles.
# ASCII-only on purpose: PowerShell 5.1 reads UTF-8-without-BOM files as ANSI.
param([int]$WaitSeconds = 50)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$flag = Join-Path $root 'logs\force.flag'
$deadline = (Get-Date).AddSeconds($WaitSeconds)

while ((Get-Date) -lt $deadline) {
    if (Test-Path $flag) {
        & (Join-Path $root 'run-checkin.ps1') -Force
        exit $LASTEXITCODE
    }
    Start-Sleep -Milliseconds 1500
}
exit 0