param([switch]$Force)
# Daily check-in entry point.
# 1) launches the apps minimized & without stealing focus (only if they are not already running)
# 2) remembers which pids we started, so the node part can close only those
# 3) runs checkin.mjs to do the actual signing
# ASCII-only comments on purpose: PowerShell 5.1 reads UTF-8-without-BOM as ANSI.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'runner.log'
$progressFile = Join-Path $logDir 'progress.json'

# Progress file consumed by the board service (shows "signing in ..." in the panel).
# ASCII-only stage names on purpose: PowerShell 5.1 reads this file as ANSI.
function Write-CheckinProgress([string]$stage, $extra) {
    $o = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); stage = $stage }
    if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
    try {
        [System.IO.File]::WriteAllText($progressFile, ($o | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
    } catch { }
}

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$OutputEncoding = [System.Text.Encoding]::UTF8
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# ---------- schedule gate ----------
# The task ticks every 15 minutes; a run happens once the configured checkinTime
# has passed today, or immediately when logs\force.flag exists.
$stateFile = Join-Path $root 'logs\last-run.txt'
$forceFile = Join-Path $root 'logs\force.flag'
$cfgPath = Join-Path $root 'config.json'
$cfgObj = @{}
if (Test-Path $cfgPath) { try { $cfgObj = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch { $cfgObj = @{} } }
$checkinTime = '09:30'
if ($cfgObj.checkinTime -match '^\d{2}:\d{2}$') { $checkinTime = $cfgObj.checkinTime }
$lastDate = ''
if (Test-Path $stateFile) { try { $lastDate = (Get-Content $stateFile -Raw).Trim() } catch { } }
$forced = $Force -or (Test-Path $forceFile)
if ($forced) { Remove-Item $forceFile -Force -ErrorAction SilentlyContinue }
$now = Get-Date
$tgt = [datetime]::ParseExact($checkinTime, 'HH:mm', $null)
$targetToday = $now.Date.AddHours($tgt.Hour).AddMinutes($tgt.Minute)
if (-not $forced) {
    if ($now.ToString('yyyy-MM-dd') -eq $lastDate) { Add-Content -Path $log -Value ('[{0}] skip: already ran today' -f (Get-Date -Format 'HH:mm:ss')); exit 0 }
    if ($now -lt $targetToday) { Add-Content -Path $log -Value ('[{0}] skip: waiting for {1}' -f (Get-Date -Format 'HH:mm:ss'), $checkinTime); exit 0 }
}
# keepOpen: keep the clients running after check-in (default false = close what we started)
$keepOpen = $false
$cfgPath = Join-Path $root 'config.json'
if (Test-Path $cfgPath) {
    try { $keepOpen = [bool](Get-Content $cfgPath -Raw | ConvertFrom-Json).keepOpen } catch { $keepOpen = $false }
}
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path $log -Value ("[{0}] ---- start ----" -f $stamp)
Write-CheckinProgress 'launching'

# ---------- minimized launcher ----------
if (-not ("QuietLauncher" -as [type])) {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public class QuietLauncher
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    const int SW_SHOWMINNOACTIVE = 7;
    const int SW_MINIMIZE = 6;
    const uint HWND_BOTTOM = 1;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOACTIVATE = 0x0010;

    public static int Launch(string exe, string appArgs, string cwd, int waitMs, out int tamed)
    {
        tamed = 0;
        if (string.IsNullOrEmpty(cwd)) cwd = Path.GetDirectoryName(exe);
        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = 1;
        si.wShowWindow = SW_SHOWMINNOACTIVE;

        string cmd = "\"" + exe + "\"";
        if (!string.IsNullOrEmpty(appArgs)) cmd += " " + appArgs;

        PROCESS_INFORMATION pi;
        if (!CreateProcess(exe, cmd, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, cwd, ref si, out pi)) return -1;
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);

        string name = Path.GetFileNameWithoutExtension(exe);
        var deadline = DateTime.UtcNow.AddMilliseconds(waitMs);
        while (DateTime.UtcNow < deadline)
        {
            Thread.Sleep(300);
            foreach (var p in Process.GetProcesses())
            {
                try
                {
                    if (!string.Equals(p.ProcessName, name, StringComparison.OrdinalIgnoreCase)) continue;
                    IntPtr h = p.MainWindowHandle;
                    if (h == IntPtr.Zero || !IsWindowVisible(h)) continue;
                    ShowWindow(h, SW_MINIMIZE);
                    SetWindowPos(h, (IntPtr)HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                    tamed++;
                }
                catch { }
            }
            if (tamed > 0) break;
        }
        return pi.dwProcessId;
    }
}
'@
}

function Test-Running([string]$name) {
    $p = Get-Process -Name $name -ErrorAction SilentlyContinue
    return [bool]$p
}

function Test-PortOpen([int]$port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(700)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch { return $false } finally { try { $client.Close() } catch { } }
}

$apps = @(
    @{ key = 'workbuddy'; proc = 'WorkBuddy'; exe = (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\WorkBuddy.exe'); args = '--remote-debugging-port=9533'; port = 9533; restart = $true },
    @{ key = 'doubao';    proc = 'Doubao';    exe = (Join-Path $env:LOCALAPPDATA 'Doubao\Application\Doubao\Doubao.exe'); args = '--remote-debugging-port=9531'; port = 9531; restart = $true }
    @{ key = 'codearts';  proc = 'CodeArts';  exe = (Join-Path $env:LOCALAPPDATA 'Programs\CodeArts\CodeArts.exe'); args = '--remote-debugging-port=9534'; port = 9534; restart = $true }
    @{ key = 'astudio';   proc = 'AStudio';   exe = (Join-Path $env:LOCALAPPDATA 'Programs\AStudio\AStudio.exe');   args = '--remote-debugging-port=9535'; port = 9535; restart = $false }
)

# AStudio wiring: optional "astudio" block in config.json (enabled / exe / port / restart)
#   "astudio": { "enabled": true, "exe": "C:\\...\\AStudio.exe", "port": 9535 }
$asCfg = $cfgObj.astudio
$asEntry = $apps | Where-Object { $_.key -eq 'astudio' }
if ($asCfg -and $asEntry) {
    if ($null -ne $asCfg.enabled -and -not [bool]$asCfg.enabled) {
        $apps = @($apps | Where-Object { $_.key -ne 'astudio' })
        Add-Content -Path $log -Value ('[{0}] astudio disabled in config, skipped' -f (Get-Date -Format 'HH:mm:ss'))
    } else {
        if ($asCfg.port) { $asEntry.port = [int]$asCfg.port; $asEntry.args = "--remote-debugging-port=$($asEntry.port)" }
        if ($asCfg.exe) { $asEntry.exe = [string]$asCfg.exe }
        if ($null -ne $asCfg.restartIfOpenWithoutPort) { $asEntry.restart = [bool]$asCfg.restartIfOpenWithoutPort }
    }
}

# Apps that were already running (without a debug port) get restarted once so
# CDP can drive them. They belong to the user, so they are left running
# afterwards instead of being closed with the ones this run started.
$launched = @{}
$restarted = @{}
foreach ($a in $apps) {
    if (Test-Running $a.proc) {
        if ($a.port -gt 0 -and -not (Test-PortOpen $a.port)) {
            if (-not $a.restart) {
                # IDE-like client: do not restart it just to get a debug port (the user may be working in it)
                Add-Content -Path $log -Value ("[{0}] {1} running without debug port {2}, no restart (kept open)" -f (Get-Date -Format 'HH:mm:ss'), $a.key, $a.port)
                continue
            }
            Add-Content -Path $log -Value ("[{0}] {1} running without debug port {2}, restarting" -f (Get-Date -Format 'HH:mm:ss'), $a.key, $a.port)
            Stop-Process -Name $a.proc -Force -ErrorAction SilentlyContinue
            $restarted[$a.key] = $true
            Start-Sleep -Milliseconds 2000
        } else {
            Add-Content -Path $log -Value ("[{0}] {1} already running, keep as is" -f (Get-Date -Format 'HH:mm:ss'), $a.key)
            continue
        }
    }
    if (-not (Test-Path $a.exe)) {
        Add-Content -Path $log -Value ("[{0}] {1} exe not found: {2}" -f (Get-Date -Format 'HH:mm:ss'), $a.key, $a.exe)
        continue
    }
    $tamed = 0
    $pid2 = [QuietLauncher]::Launch($a.exe, $a.args, '', 8000, [ref]$tamed)
    if ($pid2 -gt 0) {
        $launched[$a.key] = $pid2
        Add-Content -Path $log -Value ("[{0}] launched {1} pid={2} minimized_windows={3}" -f (Get-Date -Format 'HH:mm:ss'), $a.key, $pid2, $tamed)
    } else {
        Add-Content -Path $log -Value ("[{0}] FAILED to launch {1}" -f (Get-Date -Format 'HH:mm:ss'), $a.key)
    }
}
$json = $launched | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path $logDir 'launch.json'), $json, (New-Object System.Text.UTF8Encoding($false)))

# ---------- run the signing logic ----------
$node = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path $node)) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
}
if (-not $node -or -not (Test-Path $node)) {
    Add-Content -Path $log -Value ("[{0}] node runtime not found" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    exit 1
}

$output = ''
$code = 1
try {
    $output = & $node (Join-Path $root 'checkin.mjs') 2>&1 | Out-String
    $code = $LASTEXITCODE
}
finally {
    # close only the apps this run started; never touch windows the user opened
if ($code -eq 0) {
        Set-Content -Path $stateFile -Value (Get-Date -Format 'yyyy-MM-dd') -Encoding ASCII
        # 今天已签过：停掉每 15 分钟的轮询，明天 00:05 由 DSH-CheckinReset 重新启用
        cmd /c "schtasks /change /tn DSH-DailyCheckin /disable >nul 2>&1"
        Add-Content -Path $log -Value ('[{0}] check-in done, polling paused until tomorrow' -f (Get-Date -Format 'HH:mm:ss'))
    }
    $procMap = @{ workbuddy = 'WorkBuddy'; doubao = 'Doubao'; codearts = 'CodeArts'; astudio = 'AStudio' }
    if ($keepOpen) {
        Add-Content -Path $log -Value ("[{0}] keepOpen=true, leave clients running" -f (Get-Date -Format 'HH:mm:ss'))
    }
    foreach ($k in @($launched.Keys)) {
        if ($keepOpen) { break }
        if ($restarted.ContainsKey($k)) {
            Add-Content -Path $log -Value ("[{0}] {1} was already running before, left open" -f (Get-Date -Format 'HH:mm:ss'), $k)
            continue
        }
        $pn = $procMap[$k]
        if (-not $pn) { continue }
        if (Get-Process -Name $pn -ErrorAction SilentlyContinue) {
            Stop-Process -Name $pn -Force -ErrorAction SilentlyContinue
            Add-Content -Path $log -Value ("[{0}] closed {1}" -f (Get-Date -Format 'HH:mm:ss'), $k)
        }
    }
    Add-Content -Path $log -Value $output -Encoding UTF8
    Add-Content -Path $log -Value ("[{0}] ---- done exit={1} ----" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $code)
    Write-CheckinProgress 'done' @{ ok = ($code -eq 0) }
}

exit $code
