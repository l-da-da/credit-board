# 卸载：删除计划任务、停止服务、可选删除安装目录
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 [-RemoveFiles]
param(
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'credit-board'),
    [switch]$RemoveFiles
)

$ErrorActionPreference = 'Continue'

foreach ($t in @('DSH-DailyCheckin', 'DSH-CheckinReset', 'DSH-CheckinNow', 'DSH-CreditBoard', 'DSH-CreditCollect')) {
    cmd /c "schtasks /delete /tn $t /f >nul 2>&1"
    Write-Output "removed task: $t"
}

Get-Process node -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -like "*$Target*" } |
    Stop-Process -Force -ErrorAction SilentlyContinue

if ($RemoveFiles) {
    Remove-Item $Target -Recurse -Force -ErrorAction SilentlyContinue
    Write-Output "removed folder: $Target"
} else {
    Write-Output "files kept at: $Target (use -RemoveFiles to delete)"
}

Write-Output ''
Write-Output '别忘了：在 DeepSeek Harness 的 Plugins 里移除 @local/credit-board。'