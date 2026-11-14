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

$user = "$env:USERDOMAIN\$env:USERNAME"

function Register-Task($taskName, $xml) {
    $xmlPath = Join-Path $root ("dsh-" + $taskName + ".xml")
    [System.IO.File]::WriteAllText($xmlPath, $xml, [System.Text.Encoding]::Unicode)
    cmd /c "schtasks /delete /tn $taskName /f >nul 2>&1"
    schtasks /create /tn $taskName /xml $xmlPath /f | Out-Null
    $code = $LASTEXITCODE
    Remove-Item $xmlPath -Force -ErrorAction SilentlyContinue
    if ($code -ne 0) { Write-Output "FAILED to register $taskName"; exit 1 }
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

# 2) one-shot collector for the refresh button
Register-Task 'DSH-CreditCollect' (Task-Xml 'Credit board: collect balances' '' $ps "-NoProfile -ExecutionPolicy Bypass -File `"$collect`"")

schtasks /end /tn DSH-CreditBoard 2>&1 | Out-Null
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