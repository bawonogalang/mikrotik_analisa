' Menjalankan web monitoring di latar belakang (tanpa jendela).
' Dipanggil otomatis dari folder Startup Windows setiap login.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "cmd /c """ & dir & "\jalan-terus.cmd""", 0, False
