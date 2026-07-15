Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = appDir & "\tools\start_app.ps1"

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & scriptPath & Chr(34)
shell.Run command, 0, False
