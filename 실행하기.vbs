' 콘솔 창이 아예 안 뜨게 preflight.ps1을 숨김 모드로 실행한다.
' (.bat/cmd 창은 더블클릭하는 순간 무조건 한 번은 화면에 나타나서, 그걸 피하려면 .vbs로 띄워야 한다)
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & folder & "\preflight.ps1"""
CreateObject("WScript.Shell").Run cmd, 0, False
