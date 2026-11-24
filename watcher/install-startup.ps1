# Creates a Startup-folder shortcut so the watcher runs when you log in.
$startup = [Environment]::GetFolderPath("Startup")
$target  = Join-Path $PSScriptRoot "start-watcher.vbs"
$lnk     = Join-Path $startup "Goal Nudge Watcher.lnk"
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = "wscript.exe"
$s.Arguments  = "`"$target`""
$s.WorkingDirectory = $PSScriptRoot
$s.Save()
Write-Host "Installed: $lnk"
