# Register the credit-board service and its on-demand collect task.
# DSH-CreditBoard   : runs board-server.mjs at sign-in (hidden, restarts on failure)
# DSH-CreditCollect : one-shot balance collector, triggered by the board's refresh button
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = Join-Path $root 'runtime\node.exe'
$server = Join-Path $root 'board-server.mjs'
$collect = Join-Path $root 'collect.ps1'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

if (-not (Test-Path $node)) { Write-Output "node missing: $node"; exit 1 }
if (-not (Test-Path $server)) { Write-Output "server missing: $server"; exit 1 }
if (-not (Test-Path $collect)) { Write-Output "collect missing: $collect"; exit 1 }
$collectTick = Join-Path $root 'collect-now.ps1'
if (-not (Test-Path $collectTick)) { Write-Output "collect tick missing: $collectTick"; exit 1 }

$user = "$env:USERDOMAIN\$env:USERNAME"

function Register-Task($taskName, $xml) {
    # Use the Schedule.Service COM API (Register-ScheduledTask) instead of schtasks.exe:
    # when this script is spawned from the board service process, schtasks.exe fails with
    # ERROR_PATH_NOT_FOUND even for the user's own tasks. COM registration works everywhere.
    $xmlPath = Join-Path $root ("dsh-" + $taskName + ".xml")
    [System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue } catch { }
    try {
        Register-ScheduledTask -TaskName $taskName -Xml (Get-Content $xmlPath -Raw) -ErrorAction Stop | Out-Null
    } catch {
        Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
        Write-Output ("FAILED to register {0}: {1}" -f $taskName, $_.Exception.Message)
        exit 1
    }
    Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
    Write-Output "registered $taskName"
}

function Task-Xml($description, $triggerXml, $command, $arguments) {
    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>$description</Description></RegistrationInfo>
  <Triggers>$triggerXml</Triggers>
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
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
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

# 1) the long-running board service, started at sign-in
$serverTrigger = @"
<LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$user</UserId>
      <Delay>PT20S</Delay>
    </LogonTrigger>
"@
Register-Task 'DSH-CreditBoard' (Task-Xml 'Credit board data service (127.0.0.1:47122)' $serverTrigger $node "`"$server`"")

# 2) collector: a 1-minute tick consumes logs\refresh.flag dropped by the board service,
#    then collects balances in the reliable Calendar-triggered task context
$start = (Get-Date -Format 'yyyy-MM-dd') + 'T00:00:00'
$collectTrigger = @"
<CalendarTrigger>
      <StartBoundary>$start</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$user</UserId>
      <Delay>PT2M</Delay>
    </LogonTrigger>
"@
Register-Task 'DSH-CreditCollect' (Task-Xml 'Credit board: 1-min tick consumes logs\refresh.flag, then collects balances' $collectTrigger $ps "-NoProfile -ExecutionPolicy Bypass -File `"$collectTick`"")

schtasks /end /tn DSH-CreditBoard 2>&1 | Out-Null
Start-Sleep -Seconds 2
# /end does not always kill the task's process tree; a stale instance would keep
# holding port 47122 and the fresh one would exit silently (EADDRINUSE).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*board-server.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
schtasks /run /tn DSH-CreditBoard | Out-Null
Start-Sleep -Seconds 4

try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:47122/board" -UseBasicParsing -TimeoutSec 5
    Write-Output "service OK: $($r.StatusCode)"
} catch {
    Write-Output "service not reachable: $($_.Exception.Message)"
    Write-Output "log: $root\logs\board-server.log"
}