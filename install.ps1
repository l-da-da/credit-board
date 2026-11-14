# 一键安装：把每日签到 + 额度看板装到本机
# 用法（PowerShell）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# 可选参数：-Target <安装目录>   默认 %LOCALAPPDATA%\credit-board
param(
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'credit-board')
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$srcScripts = Join-Path $root 'auto-checkin'
$srcPlugin = Join-Path $root 'plugin'

if (-not (Test-Path $srcScripts)) { Write-Output "missing: $srcScripts"; exit 1 }
if (-not (Test-Path $srcPlugin)) { Write-Output "missing: $srcPlugin"; exit 1 }

Write-Output "安装目录: $Target"
New-Item -ItemType Directory -Force -Path $Target | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Target 'logs') | Out-Null

# 1) 脚本
Copy-Item (Join-Path $srcScripts '*') $Target -Recurse -Force

# 2) 插件
$pluginTarget = Join-Path $Target 'plugin'
if (Test-Path $pluginTarget) { Remove-Item $pluginTarget -Recurse -Force }
New-Item -ItemType Directory -Force -Path $pluginTarget | Out-Null
Copy-Item (Join-Path $srcPlugin '*') $pluginTarget -Recurse -Force

# 3) 把插件的 checkinDir 指向安装目录（YAML 里用单引号，反斜杠不用转义）
$patchFile = Join-Path $pluginTarget 'cordis.patch.yml'
$patch = Get-Content $patchFile -Raw
$patch = $patch.Replace('__CHECKIN_DIR__', $Target)
[System.IO.File]::WriteAllText($patchFile, $patch, (New-Object System.Text.UTF8Encoding($false)))

# 4) 默认配置（签到后不保留客户端）
$cfg = Join-Path $Target 'config.json'
if (-not (Test-Path $cfg)) {
    [System.IO.File]::WriteAllText($cfg, "{`n  `"keepOpen`": false`n}`n", (New-Object System.Text.UTF8Encoding($false)))
}

# 5) Node 运行时检查
$node = Join-Path $Target 'runtime\node.exe'
if (-not (Test-Path $node)) {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) {
        $ver = (& $c.Source -v) 2>$null
        Write-Output "使用系统 Node: $($c.Source) $ver"
        Write-Output "提示: 需要 Node.js 22 及以上（用到了内置 WebSocket）"
    } else {
        Write-Output '未找到 Node.js。请安装 Node.js 22+，或把 node.exe 放到 runtime\node.exe 后重跑本脚本。'
        exit 1
    }
}

# 6) 注册计划任务
Write-Output ''
Write-Output '注册签到任务...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Target 'install-task.ps1')
Write-Output ''
Write-Output '注册看板服务...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Target 'install-board.ps1')

Write-Output ''
Write-Output '=============================='
Write-Output '安装完成。还差一步：把插件加进 DeepSeek Harness'
Write-Output ''
Write-Output "  DSH 里：设置 → Plugins → Add plugin → 选择目录："
Write-Output "  $pluginTarget"
Write-Output ''
Write-Output '  或者在会话里让 agent 执行：plugin_manager install_bundle target=<上面那个路径>'
Write-Output ''
Write-Output '然后刷新 DSH 页面（F5），侧边栏底部会出现「💰 额度」。'
Write-Output ''
Write-Output '手动签到：schtasks /run /tn DSH-DailyCheckin'
Write-Output '手动采集余额：schtasks /run /tn DSH-CreditCollect'
Write-Output '重启看板服务：powershell -File auto-checkin\install-board.ps1   # 不要只用 schtasks /end + /run'
Write-Output '日志目录：'
Write-Output "  $Target\logs"
Write-Output '=============================='