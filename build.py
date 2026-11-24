"""Builds dist/goal-nudge-firefox.zip (upload to AMO), dist/goal-nudge-chrome.zip (send to friends)
and, with --exe, dist/GoalNudgeWatcher.exe (needs `pip install pyinstaller`)."""
import os, subprocess, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = ["background.js", "content.js", "defaults.js", "icon.svg", "icon48.png", "icon128.png", "options.html", "options.js",
         "popup.html", "popup.js", "shared.css"]

def build(name, manifest_file):
    os.makedirs(os.path.join(HERE, "dist"), exist_ok=True)
    out = os.path.join(HERE, "dist", name)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in FILES:
            z.write(os.path.join(HERE, f), f)
        z.write(os.path.join(HERE, manifest_file), "manifest.json")
    print("built", out)

build("goal-nudge-firefox.zip", "manifest.json")
build("goal-nudge-chrome.zip", "manifest.chrome.json")

if "--exe" in sys.argv:
    w = os.path.join(HERE, "watcher")
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--onefile", "--noconsole",
                    "--name", "GoalNudgeWatcher", "--icon", os.path.join(w, "icon.ico"),
                    "--distpath", os.path.join(HERE, "dist"),
                    "--workpath", os.path.join(w, "build"), "--specpath", os.path.join(w, "build"),
                    os.path.join(w, "watcher.py")], check=True)
    print("built", os.path.join(HERE, "dist", "GoalNudgeWatcher.exe"))
