Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
strDir = FSO.GetParentFolderName(WScript.ScriptFullName)
psFile = strDir & "\AgentPet.ps1"
If Not FSO.FileExists(psFile) Then
    WScript.Echo "AgentPet.ps1 is missing. Please extract the complete AgentPet package again."
    WScript.Quit 1
End If
strCmd = """C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File """ & psFile & """"
WshShell.Run strCmd, 0, False
