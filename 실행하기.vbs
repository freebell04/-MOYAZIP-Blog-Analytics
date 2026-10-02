' Naver Blog Helper Studio launcher (relative path). First run creates the desktop-style shortcut next to this file.
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "wscript.exe """ & folder & "\app\scripts\launch.vbs""", 0, False
