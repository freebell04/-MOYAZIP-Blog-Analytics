' Naver Blog Helper Studio launcher: start hidden (no console window), preflight does update + start
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & folder & "\preflight.ps1"""
CreateObject("WScript.Shell").Run cmd, 0, False
