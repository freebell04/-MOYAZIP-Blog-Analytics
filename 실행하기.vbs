' Naver Blog Helper launcher: check for updates -> update -> start (no console window)
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & folder & "\app\scripts\preflight.ps1"""
CreateObject("WScript.Shell").Run cmd, 0, False
