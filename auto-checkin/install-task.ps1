# Register the check-in tasks.
#   DSH-DailyCheckin  : polls every 15 minutes; run-checkin.ps1 decides whether it is time
#                       (config.json checkinTime) and disables itself for the rest of the day
#                       once today's check-in succeeded.
#   DSH-CheckinReset  : daily 00:05, re-enables DSH-DailyCheckin
#   DSH-CheckinNow    : on-demand, runs the check-in immediately (panel button)
# ASCII-only on purpose: PowerShell 5.1 reads UTF-8-without-BOM files as ANSI.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$user = "$env:USERDOMAIN\$env:USERNAME"
$start = (Get-Date -Format 'yyyy-MM-dd') + 'T00:00:00'
$resetStart = (Get-Date -Format 'yyyy-MM-dd') + 'T00:05:00'

# wrappers
$cmdNormal = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"%~dp0run-checkin.ps1`"`r`n"
[System.IO.File]::WriteAllText((Join-Path $root 'run-checkin.cmd'), $cmdNormal, (New-Object System.Text.ASCIIEncoding))
$cmdForce = "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"%~dp0run-checkin.ps1`" -Force`r`n"
[System.IO.File]::WriteAllText((Join-Path $root 'run-checkin-force.cmd'), $cmdForce, (New-Object System.Text.ASCIIEncoding))

function Register-Task($taskName, $xml) {
    $xmlPath = Join-Path $root ("task-" + $taskName + ".xml")
    [System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)
    cmd /c "schtasks /delete /tn $taskName /f >nul 2>&1"
    schtasks /create /tn $taskName /xml $xmlPath /f | Out-Null
    $code = $LASTEXITCODE
    Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
    if ($code -ne 0) { Write-Output "FAILED to register $taskName (exit $code)"; exit 1 }
}

function Task-Xml($description, $triggers, $command, $arguments) {
    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>$description</Description></RegistrationInfo>
  <Triggers>$triggers</Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$command</Command>
      <Arguments>$arguments</Arguments>
      <WorkingDirectory>$root</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
}

# 1) main polling task
$pollTriggers = @"
<CalendarTrigger>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT15M</Interval>
        <Duration>P1D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$user</UserId>
      <Delay>PT3M</Delay>
    </LogonTrigger>
"@
Register-Task 'DSH-DailyCheckin' (Task-Xml 'Daily check-in (polls every 15 min, pauses after a successful run)' $pollTriggers (Join-Path $root 'run-checkin.cmd') '')

# 2) daily reset at 00:05
$resetTriggers = @"
<CalendarTrigger>
      <StartBoundary>$resetStart</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
"@
Register-Task 'DSH-CheckinReset' (Task-Xml 'Re-enable the daily check-in polling task' $resetTriggers $ps "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $root 'enable-checkin.ps1')`"")

# 3) on-demand check-in (panel button)
Register-Task 'DSH-CheckinNow' (Task-Xml 'Run the check-in immediately' '' (Join-Path $root 'run-checkin-force.cmd') '')

$info = schtasks /query /tn DSH-DailyCheckin /fo LIST /v
$info | Select-String -Pattern 'TaskName|Status|Next Run Time'
Write-Output ''
Write-Output 'Tasks registered: DSH-DailyCheckin, DSH-CheckinReset, DSH-CheckinNow'
Write-Output 'Run now: schtasks /run /tn DSH-CheckinNow'
Write-Output 'Logs: <folder>\logs\runner.log'