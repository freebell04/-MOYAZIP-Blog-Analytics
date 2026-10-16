' Naver Blog Helper: stop the background server (result shown in a message box)
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & folder & "\app\scripts\stop.ps1"""
CreateObject("WScript.Shell").Run cmd, 0, False
