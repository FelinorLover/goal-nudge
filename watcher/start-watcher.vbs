' Launches the watcher with no console window. Put a shortcut to this in shell:startup.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = Replace(WScript.ScriptFullName, WScript.ScriptName, "")
sh.Run "pythonw.exe watcher.py", 0, False
