' hidden-tick.vbs - run a PowerShell script located in the same folder,
' completely hidden (Task Scheduler does not hide console windows, so a direct
' powershell.exe action flashes a window on every tick).
' Usage: wscript //B //Nologo hidden-tick.vbs <script.ps1>
' Waits for completion and forwards the exit code, so the task's
' Last Result still reflects the script outcome.
Dim root, sh, cmd
root = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & root & "\" & WScript.Arguments(0) & """"
WScript.Quit(sh.Run(cmd, 0, True))
