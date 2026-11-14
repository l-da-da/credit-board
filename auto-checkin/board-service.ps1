# Run the board data service (runtime\node.exe board-server.mjs).
# Launched via hidden-tick.vbs (wscript) so no console window ever shows.
# Why the extra powershell layer: on machines where script hosts are only
# allowed to spawn cmd/powershell, wscript -> node hangs; wscript -> powershell
# -> node works (same chain the check-in/collect tasks use every day).
# ASCII-only on purpose: PowerShell 5.1 reads UTF-8-without-BOM files as ANSI.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $root 'runtime\node.exe') (Join-Path $root 'board-server.mjs')
exit $LASTEXITCODE
