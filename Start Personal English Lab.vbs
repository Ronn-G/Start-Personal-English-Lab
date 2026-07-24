Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = appDir & "\tools\start_app.ps1"

command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & scriptPath & Chr(34)
exitCode = shell.Run(command, 0, True)

If exitCode <> 0 Then
    logPath = appDir & "\.logs\launcher.log"
    shell.Popup "Khong the khoi dong Personal English Lab." & vbCrLf & _
        "Xem loi tai:" & vbCrLf & logPath, 0, "Personal English Lab", 16
End If
