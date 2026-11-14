# Collect balances: start apps minimized (with debug ports), run collect.mjs, close what we started.
# Uses Start-Process only (no Add-Type) so it also works when launched by another process.
# ASCII-only on purpose: PowerShell 5.1 reads UTF-8-without-BOM files as ANSI.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'collect.log'

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

function Test-Running([string]$name) { return [bool](Get-Process -Name $name -ErrorAction SilentlyContinue) }

$apps = @(
    @{ key = 'workbuddy'; proc = 'WorkBuddy'; exe = (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\WorkBuddy.exe'); args = '--remote-debugging-port=9533' },
    @{ key = 'doubao';   proc = 'Doubao';   exe = (Join-Path $env:LOCALAPPDATA 'Doubao\Application\Doubao\Doubao.exe'); args = '--remote-debugging-port=9531' },
    @{ key = 'codearts'; proc = 'CodeArts'; exe = (Join-Path $env:LOCALAPPDATA 'Programs\CodeArts\CodeArts.exe'); args = '--remote-debugging-port=9534' }
    @{ key = 'autoclaw'; proc = 'AutoClaw2'; exe = (Join-Path $env:LOCALAPPDATA 'Programs\AutoClaw2\AutoClaw2.exe'); args = '--remote-debugging-port=9532' }
)

$launched = @()
foreach ($a in $apps) {
    if (Test-Running $a.proc) { continue }
    if (-not (Test-Path $a.exe)) { continue }
    try {
        Start-Process -FilePath $a.exe -ArgumentList $a.args -WorkingDirectory (Split-Path -Parent $a.exe) -WindowStyle Minimized
        $launched += $a.key
    } catch {
        Add-Content -Path $log -Value ("[{0}] start failed {1}: {2}" -f (Get-Date -Format 'HH:mm:ss'), $a.key, $_.Exception.Message)
    }
}
Add-Content -Path $log -Value ("[{0}] launched: {1}" -f (Get-Date -Format 'HH:mm:ss'), ($launched -join ','))

$keepOpen = $false
$cfgPath = Join-Path $root 'config.json'
if (Test-Path $cfgPath) {
    try { $keepOpen = [bool](Get-Content $cfgPath -Raw | ConvertFrom-Json).keepOpen } catch { $keepOpen = $false }
}
$node = Join-Path $root 'runtime\node.exe'
$out = & $node (Join-Path $root 'collect.mjs') 2>&1 | Out-String
$code = $LASTEXITCODE
Add-Content -Path $log -Value $out -Encoding UTF8

$procMap = @{ workbuddy = 'WorkBuddy'; doubao = 'Doubao'; autoclaw = 'AutoClaw2'; codearts = 'CodeArts' }
foreach ($k in $launched) {
    if ($keepOpen) { break }
    $pn = $procMap[$k]
    if ($pn -and (Get-Process -Name $pn -ErrorAction SilentlyContinue)) {
        Stop-Process -Name $pn -Force -ErrorAction SilentlyContinue
    }
}
Add-Content -Path $log -Value ("[{0}] done exit={1}" -f (Get-Date -Format 'HH:mm:ss'), $code)
exit $code
