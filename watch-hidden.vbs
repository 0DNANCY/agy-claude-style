Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
If WScript.Arguments.Count = 0 Then
  args = " --watch --replace"
Else
  For i = 0 To WScript.Arguments.Count - 1
    args = args & " """ & Replace(WScript.Arguments(i), """", "\""") & """"
  Next
End If
CreateObject("WScript.Shell").Run "node """ & dir & "\inject.js""" & args, 0, False
