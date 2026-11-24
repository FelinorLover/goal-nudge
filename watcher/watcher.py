"""Goal Nudge desktop watcher.

Polls Windows for two kinds of distraction and puts a full-screen nudge up:

  * a game is running      - Steam's RunningAppID registry value, or any exe
                              name listed under "games" in config.json
  * a Discord voice call    - Discord holding an active WASAPI capture session
                              (falls back to Windows' mic consent-store registry)

Also runs a tiny HTTP server on 127.0.0.1 so the browser extension can push its
goals / pause state here, keeping the two in sync.  Stdlib only.

Run:  pythonw watcher.py            (silent, for startup)
      python  watcher.py --monitor 1   (visible console, overlay on 2nd monitor)
      python  watcher.py --demo        (show the overlay once and exit)
      python  watcher.py --demo --demo-reason   (same, with the typed-reason box forced on)
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import re
import subprocess
import sys
import threading
import time
import tkinter as tk
import urllib.request
import winreg
import winsound
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Next to the script, or next to the .exe when packaged with PyInstaller.
HERE = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
REASONS_PATH = os.path.join(HERE, "reasons.log")

DEFAULTS = {
    "goals": [
        "Example: finish the side project by December",
        "Example: read 20 pages a day",
    ],
    # Exe names (case-insensitive). Steam games are detected automatically.
    "games": [
        "RobloxPlayerBeta.exe",
        "VALORANT-Win64-Shipping.exe",
        "LeagueClient.exe",
        "League of Legends.exe",
    ],
    "watch_steam": True,
    "watch_discord_voice": True,
    # Steam apps never nagged: appids or names (case-insensitive substring).
    "steam_allow": [],
    # Steam store genres that mean "tool, not game" — these are skipped automatically.
    "steam_tool_genres": [
        "Animation & Modeling", "Design & Illustration", "Video Production",
        "Audio Production", "Photo Editing", "Utilities", "Web Publishing",
        "Software Training", "Game Development", "Education",
    ],
    # appid -> True if it's a tool. Filled in from the Steam store, cached forever.
    "steam_is_tool": {},
    "delay_seconds": 5,
    # Each "Continue anyway" today on the same trigger doubles the countdown, up to the cap.
    "escalate": True,
    "max_delay_seconds": 120,
    # Make "Continue anyway" need a typed reason (logged to reasons.log).
    "require_reason": False,
    "min_reason_chars": 8,
    "cooldown_minutes": 15,
    # After "I'll leave the call": how long before it checks whether you actually did.
    "leave_grace_minutes": 2,
    "poll_seconds": 2,
    "port": 47831,
    "overlay_monitor": "primary",  # "primary" or a 0-based index into the monitor list
    "beep": True,
    "paused_until": 0,
    "work_hours": {"enabled": False, "start": "09:00", "end": "18:00", "days": [1, 2, 3, 4, 5]},
}

lock = threading.Lock()
config = {}


def load_config():
    global config
    data = {}
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
    config = {**DEFAULTS, **data}
    save_config()


def save_config():
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


def compute_delay(base, escalate, max_delay, continues_today):
    """Countdown length: doubles with every "Continue anyway" today, capped at max_delay."""
    base = float(base)
    if base <= 0:
        return 0
    if not escalate:
        return int(base)
    return int(min(max_delay, base * 2 ** min(int(continues_today), 30)))


def log_reason(trigger, reason):
    """Append one JSON line per typed reason, next to config.json."""
    entry = {"t": int(time.time() * 1000), "kind": trigger["kind"], "label": trigger["label"], "reason": reason}
    try:
        with open(REASONS_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as e:
        print("could not write reasons.log:", e, file=sys.stderr)


# --------------------------------------------------------------------------- #
# Detection
# --------------------------------------------------------------------------- #

MIC_KEY = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged"
DISCORD_MARKERS = ("discord.exe", "discordptb.exe", "discordcanary.exe", "vesktop.exe")

# --- WASAPI: which processes are actively capturing audio right now -------- #
# The registry consent store is keyed by full exe path, and Discord's path changes
# with every auto-update (app-1.0.9269\Discord.exe), so a fresh build has no key
# until Windows writes one. Asking the audio engine directly avoids that entirely.

_ole32 = ctypes.WinDLL("ole32")
CLSCTX_ALL = 23
E_CAPTURE, E_MULTIMEDIA = 1, 1
AUDIO_SESSION_ACTIVE = 1


class _GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_uint32), ("Data2", ctypes.c_uint16),
                ("Data3", ctypes.c_uint16), ("Data4", ctypes.c_ubyte * 8)]

    def __init__(self, s):
        super().__init__()
        _ole32.CLSIDFromString(ctypes.c_wchar_p(s), ctypes.byref(self))


CLSID_MMDeviceEnumerator = _GUID("{BCDE0395-E52F-467C-8E3D-C4579291692E}")
IID_IMMDeviceEnumerator = _GUID("{A95664D2-9614-4F35-A746-DE8DB63617E6}")
IID_IAudioSessionManager2 = _GUID("{77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F}")
IID_IAudioSessionControl2 = _GUID("{BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D}")


def _method(ptr, slot, *argtypes):
    """Bind the method at vtable `slot` of a COM interface pointer."""
    vtbl = ctypes.cast(ptr, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, *argtypes)(vtbl[slot])


def _release(ptr):
    if ptr:
        _method(ptr, 2)(ptr)


def capturing_pids():
    """Set of pids holding an active capture session on the default mic."""
    _ole32.CoInitialize(None)
    pids, enum, device, mgr, sessions = set(), ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    try:
        if _ole32.CoCreateInstance(ctypes.byref(CLSID_MMDeviceEnumerator), None, CLSCTX_ALL,
                                   ctypes.byref(IID_IMMDeviceEnumerator), ctypes.byref(enum)):
            return pids
        # IMMDeviceEnumerator::GetDefaultAudioEndpoint
        if _method(enum, 4, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p))(
                enum, E_CAPTURE, E_MULTIMEDIA, ctypes.byref(device)):
            return pids  # no microphone at all
        # IMMDevice::Activate
        if _method(device, 3, ctypes.POINTER(_GUID), wt.DWORD, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p))(
                device, ctypes.byref(IID_IAudioSessionManager2), CLSCTX_ALL, None, ctypes.byref(mgr)):
            return pids
        # IAudioSessionManager2::GetSessionEnumerator
        if _method(mgr, 5, ctypes.POINTER(ctypes.c_void_p))(mgr, ctypes.byref(sessions)):
            return pids
        count = ctypes.c_int()
        _method(sessions, 3, ctypes.POINTER(ctypes.c_int))(sessions, ctypes.byref(count))
        get_session = _method(sessions, 4, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p))
        for i in range(count.value):
            ctrl, ctrl2 = ctypes.c_void_p(), ctypes.c_void_p()
            if get_session(sessions, i, ctypes.byref(ctrl)):
                continue
            try:
                # QueryInterface for IAudioSessionControl2, which knows the owning pid
                if _method(ctrl, 0, ctypes.POINTER(_GUID), ctypes.POINTER(ctypes.c_void_p))(
                        ctrl, ctypes.byref(IID_IAudioSessionControl2), ctypes.byref(ctrl2)):
                    continue
                state, pid = ctypes.c_int(), wt.DWORD()
                _method(ctrl2, 3, ctypes.POINTER(ctypes.c_int))(ctrl2, ctypes.byref(state))
                _method(ctrl2, 14, ctypes.POINTER(wt.DWORD))(ctrl2, ctypes.byref(pid))
                if state.value == AUDIO_SESSION_ACTIVE and pid.value:
                    pids.add(pid.value)
            finally:
                _release(ctrl2)
                _release(ctrl)
        return pids
    except Exception:
        return pids
    finally:
        for p in (sessions, mgr, device, enum):
            _release(p)


def discord_in_voice():
    """True while Discord is actively capturing the microphone."""
    pids = capturing_pids()
    if pids:
        procs = running_processes()
        for pid in pids:
            name = os.path.basename(procs.get(pid, "")).lower()
            if name in DISCORD_MARKERS:
                return True
    return discord_in_voice_registry()


def discord_in_voice_registry():
    """Fallback: Windows' own 'mic in use' record, keyed by exe path."""
    try:
        root = winreg.OpenKey(winreg.HKEY_CURRENT_USER, MIC_KEY)
    except OSError:
        return False
    i = 0
    while True:
        try:
            sub = winreg.EnumKey(root, i)
        except OSError:
            return False
        i += 1
        if os.path.basename(sub.replace("#", "\\")).lower() not in DISCORD_MARKERS:
            continue
        try:
            with winreg.OpenKey(root, sub) as k:
                start, _ = winreg.QueryValueEx(k, "LastUsedTimeStart")
                stop, _ = winreg.QueryValueEx(k, "LastUsedTimeStop")
        except OSError:
            continue
        if start and not stop:
            return True


def steam_running_app():
    """(appid, name, install_dir) of the Steam game currently running, or None."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
            appid, _ = winreg.QueryValueEx(k, "RunningAppID")
            steam_path, _ = winreg.QueryValueEx(k, "SteamPath")
    except OSError:
        return None
    if not appid:
        return None
    name, install_dir = f"Steam app {appid}", None
    for lib in steam_libraries(steam_path):
        acf = os.path.join(lib, "steamapps", f"appmanifest_{appid}.acf")
        if os.path.exists(acf):
            text = open(acf, encoding="utf-8", errors="ignore").read()
            m = re.search(r'"name"\s+"([^"]*)"', text)
            d = re.search(r'"installdir"\s+"([^"]*)"', text)
            if m:
                name = m.group(1)
            if d:
                install_dir = os.path.join(lib, "steamapps", "common", d.group(1))
            break
    return appid, name, install_dir


def steam_app_allowed(appid, name):
    """True when this Steam app should never nag: on the allow list, or a creative tool."""
    for a in config["steam_allow"]:
        a = str(a).strip().lower()
        if a and (a == str(appid) or a in name.lower()):
            return True
    cached = config["steam_is_tool"].get(str(appid))
    if cached is None:
        cached = steam_app_is_tool(appid)
        if cached is not None:
            with lock:
                config["steam_is_tool"][str(appid)] = cached
                save_config()
    return bool(cached)


def steam_app_is_tool(appid):
    """Ask the Steam store whether this app's genres are creative-tool genres.
    None when the lookup fails, so it is retried rather than cached wrong."""
    url = f"https://store.steampowered.com/api/appdetails?appids={appid}&filters=genres"
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            entry = json.load(r).get(str(appid), {})
    except Exception:
        return None
    if not entry.get("success"):
        return None
    genres = {g.get("description", "") for g in entry.get("data", {}).get("genres", [])}
    tool_genres = set(config["steam_tool_genres"])
    # Tool only when every genre is a tool genre — "Game Development" + "Action" is a game.
    return bool(genres) and genres <= tool_genres


def steam_libraries(steam_path):
    libs = [steam_path]
    vdf = os.path.join(steam_path, "steamapps", "libraryfolders.vdf")
    if os.path.exists(vdf):
        text = open(vdf, encoding="utf-8", errors="ignore").read()
        libs += [p.replace("\\\\", "\\") for p in re.findall(r'"path"\s+"([^"]*)"', text)]
    return [os.path.normpath(p) for p in dict.fromkeys(libs)]


# Process list with full image paths, via Win32 so it's fast enough to poll.
_psapi = ctypes.WinDLL("psapi")
_kernel32 = ctypes.WinDLL("kernel32")
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def running_processes():
    """dict pid -> full exe path (processes we're allowed to inspect)."""
    count = 4096
    while True:
        arr = (wt.DWORD * count)()
        needed = wt.DWORD()
        if not _psapi.EnumProcesses(arr, ctypes.sizeof(arr), ctypes.byref(needed)):
            return {}
        if needed.value < ctypes.sizeof(arr):
            break
        count *= 2
    pids = arr[: needed.value // ctypes.sizeof(wt.DWORD)]
    out = {}
    buf = ctypes.create_unicode_buffer(1024)
    for pid in pids:
        h = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            continue
        size = wt.DWORD(len(buf))
        if _kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            out[pid] = buf.value
        _kernel32.CloseHandle(h)
    return out


_user32 = ctypes.WinDLL("user32")
_EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)


def pids_with_visible_windows():
    """Set of pids that own at least one visible top-level window."""
    found = set()

    def cb(hwnd, _):
        if _user32.IsWindowVisible(hwnd) and _user32.GetWindowTextLengthW(hwnd) > 0:
            pid = wt.DWORD()
            _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            found.add(pid.value)
        return True

    _user32.EnumWindows(_EnumWindowsProc(cb), 0)
    return found


def kill_pids(pids):
    for pid in pids:
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)


def inside_work_hours(wh):
    if not wh.get("enabled"):
        return True
    now = time.localtime()
    if (now.tm_wday + 1) % 7 not in wh["days"]:  # Python: Mon=0, config uses JS style Sun=0
        return False
    sh, sm = map(int, wh["start"].split(":"))
    eh, em = map(int, wh["end"].split(":"))
    mins, start, end = now.tm_hour * 60 + now.tm_min, sh * 60 + sm, eh * 60 + em
    return start <= mins < end if start <= end else mins >= start or mins < end


def active_triggers():
    """List of {key, kind, label, pids} for everything that should nag right now."""
    out = []
    procs = None
    if config["watch_discord_voice"] and discord_in_voice():
        out.append({"key": "discord-voice", "kind": "voice", "label": "joined a voice call on Discord", "pids": []})
    if config["watch_steam"]:
        app = steam_running_app()
        if app and not steam_app_allowed(*app[:2]):
            appid, name, install_dir = app
            procs = procs or running_processes()
            pids = [p for p, path in procs.items() if install_dir and path.lower().startswith(install_dir.lower())]
            out.append({"key": f"steam:{appid}", "kind": "game", "label": f"launched {name}", "pids": pids})
    wanted = {g.lower() for g in config["games"]}
    if wanted:
        procs = procs or running_processes()
        visible = pids_with_visible_windows()
        by_name = {}
        for pid, path in procs.items():
            n = os.path.basename(path).lower()
            # A game parked in the tray (Roblox's --launch-to-tray, launchers idling
            # in the background) has no visible window and isn't being played.
            if n in wanted and pid in visible:
                by_name.setdefault(n, []).append(pid)
        for n, pids in by_name.items():
            pretty = os.path.splitext(n)[0]
            out.append({"key": f"proc:{n}", "kind": "game", "label": f"launched {pretty}", "pids": pids})
    return out


# --------------------------------------------------------------------------- #
# Overlay
# --------------------------------------------------------------------------- #

class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def monitors():
    """[(x, y, w, h), ...] with the primary monitor first."""
    found = []
    proc_t = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.POINTER(RECT), ctypes.c_double)

    def cb(hmon, hdc, rect, data):
        r = rect.contents
        found.append((r.left, r.top, r.right - r.left, r.bottom - r.top))
        return 1

    ctypes.windll.user32.EnumDisplayMonitors(0, 0, proc_t(cb), 0)
    found.sort(key=lambda m: (m[0], m[1]) != (0, 0))
    return found


def overlay_bounds():
    mons = monitors()
    sel = config["overlay_monitor"]
    if isinstance(sel, int) and 0 <= sel < len(mons):
        return mons[sel]
    return mons[0]


class Overlay:
    BG, CARD, FG, MUTED, ACCENT = "#0a0c12", "#141824", "#e5e7eb", "#9ca3af", "#f59e0b"

    def __init__(self, root, trigger, on_continue, on_stop, delay=None):
        self.trigger, self.on_continue, self.on_stop = trigger, on_continue, on_stop
        self.left = int(config["delay_seconds"] if delay is None else delay)
        self.need_reason = bool(config["require_reason"])
        self.min_chars = max(1, int(config["min_reason_chars"]))
        self.entry = None
        x, y, w, h = overlay_bounds()

        self.win = tk.Toplevel(root, bg=self.BG)
        self.win.overrideredirect(True)
        self.win.geometry(f"{w}x{h}+{x}+{y}")
        self.win.attributes("-topmost", True)
        self.win.protocol("WM_DELETE_WINDOW", lambda: None)

        card = tk.Frame(self.win, bg=self.BG)
        card.place(relx=0.5, rely=0.5, anchor="center", width=min(600, w - 80))

        tk.Label(card, text="Are you sure?", font=("Segoe UI", 26, "bold"), fg="white", bg=self.BG).pack(anchor="w")
        tk.Label(card, text=f"You just {trigger['label']}. You said you wanted to:", font=("Segoe UI", 12),
                 fg=self.MUTED, bg=self.BG, wraplength=560, justify="left").pack(anchor="w", pady=(4, 22))

        for g in config["goals"]:
            row = tk.Frame(card, bg=self.CARD)
            row.pack(fill="x", pady=(0, 8))
            tk.Frame(row, bg=self.ACCENT, width=4).pack(side="left", fill="y")
            tk.Label(row, text=g, font=("Segoe UI", 13), fg=self.FG, bg=self.CARD, wraplength=520,
                     justify="left", padx=14, pady=10).pack(side="left", fill="x")

        if self.need_reason:
            tk.Label(card, text=f"Why are you continuing? (at least {self.min_chars} characters)",
                     font=("Segoe UI", 11), fg=self.MUTED, bg=self.BG, anchor="w").pack(fill="x", pady=(18, 6))
            self.entry = tk.Entry(card, font=("Segoe UI", 13), bg=self.CARD, fg=self.FG, insertbackground=self.FG,
                                  relief="flat", highlightthickness=1, highlightbackground="#2a3042",
                                  highlightcolor=self.ACCENT)
            self.entry.pack(fill="x", ipady=8)
            self.entry.bind("<KeyRelease>", lambda e: self._refresh())
            self.entry.bind("<Return>", lambda e: self._continue())

        btns = tk.Frame(card, bg=self.BG)
        btns.pack(fill="x", pady=(24, 0))
        stop_text = "I'll leave the call" if trigger["kind"] == "voice" else "Quit the game"
        self.stop_btn = tk.Button(btns, text=stop_text, command=self._stop, font=("Segoe UI", 12, "bold"),
                                  bg=self.ACCENT, fg="#111827", activebackground="#fbbf24", relief="flat",
                                  cursor="hand2", pady=10)
        self.stop_btn.pack(side="left", expand=True, fill="x", padx=(0, 6))
        self.cont_btn = tk.Button(btns, text="Continue anyway", command=self._continue,
                                  font=("Segoe UI", 12), bg=self.BG, fg=self.MUTED, disabledforeground="#4b5563",
                                  activebackground=self.CARD, relief="solid", bd=1, state="disabled", pady=10)
        self.cont_btn.pack(side="left", expand=True, fill="x", padx=(6, 0))

        foot = ("Continuing silences this for %d minutes." % config["cooldown_minutes"]) if trigger["kind"] != "voice" \
            else "Continuing silences this for %d minutes. If you say you'll leave, it checks again in %d." % (
                config["cooldown_minutes"], config["leave_grace_minutes"])
        tk.Label(card, text=foot, font=("Segoe UI", 9), fg="#6b7280", bg=self.BG).pack(pady=(16, 0))

        self.win.lift()
        self.win.focus_force()
        if self.entry is not None:
            self.entry.focus_force()
        if config["beep"]:
            winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
        self._tick()

    def _reason(self):
        return self.entry.get().strip() if self.entry is not None else ""

    def _ready(self):
        return self.left <= 0 and (not self.need_reason or len(self._reason()) >= self.min_chars)

    def _refresh(self):
        if self.left > 0:
            self.cont_btn.config(state="disabled", text=f"Continue anyway ({self.left})", fg=self.MUTED)
        elif not self._ready():
            self.cont_btn.config(state="disabled", text="Type a reason to continue", fg=self.MUTED)
        else:
            self.cont_btn.config(state="normal", text="Continue anyway", fg=self.FG)

    def _tick(self):
        self._refresh()
        if self.left > 0:
            self.win.after(1000, self._countdown)

    def _countdown(self):
        self.left -= 1
        self._tick()

    def _continue(self):
        if not self._ready():
            return
        reason = self._reason() if self.need_reason else None
        self.close()
        self.on_continue(self.trigger, reason)

    def _stop(self):
        self.close()
        self.on_stop(self.trigger)

    def close(self):
        try:
            self.win.destroy()
        except tk.TclError:
            pass


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #

class Watcher:
    def __init__(self, root):
        self.root = root
        self.overlay = None
        self.cooldowns = {}   # key -> expiry timestamp
        self.last_seen = {}   # key -> last time the trigger was active
        self.continues = {}   # key -> "Continue anyway" clicks today (resets when the date changes)
        self.continues_date = time.strftime("%Y-%m-%d")
        self.root.after(500, self.poll)

    def poll(self):
        try:
            self.check()
        except Exception as e:  # never let one bad tick kill the loop
            print("poll error:", e, file=sys.stderr)
        self.root.after(int(config["poll_seconds"] * 1000), self.poll)

    def check(self):
        now = time.time()
        with lock:
            paused = now < config["paused_until"] / 1000 or not inside_work_hours(config["work_hours"])
        triggers = active_triggers() if not paused else []
        keys = {t["key"] for t in triggers}
        for k in keys:
            self.last_seen[k] = now

        # A trigger that has been gone for 30s starts fresh next time.
        for k in list(self.cooldowns):
            if k not in keys and now - self.last_seen.get(k, 0) > 30:
                del self.cooldowns[k]

        if self.overlay:
            if self.overlay.trigger["key"] not in keys:
                self.overlay.close()   # they closed it / left the call themselves
                self.overlay = None
            return

        for t in triggers:
            if self.cooldowns.get(t["key"], 0) > now:
                continue
            self._roll_day()
            delay = compute_delay(config["delay_seconds"], config["escalate"], config["max_delay_seconds"],
                                  self.continues.get(t["key"], 0))
            self.overlay = Overlay(self.root, t, self.on_continue, self.on_stop, delay)
            print(f"nudge: {t['label']} (countdown {delay}s)")
            return

    def _roll_day(self):
        today = time.strftime("%Y-%m-%d")
        if today != self.continues_date:
            self.continues_date, self.continues = today, {}

    def on_continue(self, t, reason=None):
        self.overlay = None
        self._roll_day()
        self.continues[t["key"]] = self.continues.get(t["key"], 0) + 1
        if reason is not None:
            log_reason(t, reason)
        self.cooldowns[t["key"]] = time.time() + config["cooldown_minutes"] * 60

    def on_stop(self, t):
        self.overlay = None
        if t["kind"] == "voice":
            self.cooldowns[t["key"]] = time.time() + config["leave_grace_minutes"] * 60
        else:
            kill_pids(t["pids"])
            self.cooldowns[t["key"]] = time.time() + 60


# --------------------------------------------------------------------------- #
# HTTP sync with the extension
# --------------------------------------------------------------------------- #

SYNCED = {"goals": "goals", "pausedUntil": "paused_until", "workHours": "work_hours",
          "delaySeconds": "delay_seconds", "cooldownMinutes": "cooldown_minutes",
          "watchDiscordVoice": "watch_discord_voice", "watchSteam": "watch_steam",
          "steamAllow": "steam_allow", "games": "games",
          "escalate": "escalate", "maxDelaySeconds": "max_delay_seconds",
          "requireReason": "require_reason", "minReasonChars": "min_reason_chars"}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        if self.path == "/settings":
            with lock:
                self._send(200, {ext: config[local] for ext, local in SYNCED.items()})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/settings":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "bad json"})
        with lock:
            for ext, local in SYNCED.items():
                if ext in body:
                    config[local] = body[ext]
            save_config()
        self._send(200, {"ok": True})

    def log_message(self, *a):
        pass


def serve():
    srv = ThreadingHTTPServer(("127.0.0.1", config["port"]), Handler)
    srv.daemon_threads = True
    srv.serve_forever()


# --------------------------------------------------------------------------- #

def install_startup():
    """Drop a shortcut in the user's Startup folder pointing at this exe/script."""
    startup = os.path.join(os.environ["APPDATA"], r"Microsoft\Windows\Start Menu\Programs\Startup")
    lnk = os.path.join(startup, "Goal Nudge Watcher.lnk")
    if getattr(sys, "frozen", False):
        target, args = sys.executable, ""
    else:
        target = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
        args = f'"{os.path.abspath(__file__)}"'
    ps = (
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('%s'); "
        "$s.TargetPath = '%s'; $s.Arguments = '%s'; $s.WorkingDirectory = '%s'; $s.Save()"
        % (lnk, target, args, HERE)
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
    ctypes.windll.user32.MessageBoxW(0, f"Goal Nudge will start when you log in.\n\n{lnk}", "Goal Nudge", 0x40)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--monitor", type=int, help="0-based monitor index for the overlay (overrides config)")
    ap.add_argument("--demo", action="store_true", help="show the overlay once and exit")
    ap.add_argument("--demo-reason", action="store_true", help="with --demo: force the typed-reason box on")
    ap.add_argument("--install-startup", action="store_true", help="add a Startup-folder shortcut so this runs at login")
    args = ap.parse_args()

    if args.install_startup:
        install_startup()
        return

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass

    load_config()
    if args.monitor is not None:
        config["overlay_monitor"] = args.monitor
    if args.demo_reason:
        config["require_reason"] = True  # in memory only; never saved

    root = tk.Tk()
    root.withdraw()

    if args.demo:
        t = {"key": "demo", "kind": "voice", "label": "joined a voice call on Discord", "pids": []}
        Overlay(root, t, lambda t, reason=None: root.destroy(), lambda t: root.destroy(),
                compute_delay(config["delay_seconds"], config["escalate"], config["max_delay_seconds"], 0))
        root.mainloop()
        return

    threading.Thread(target=serve, daemon=True).start()
    print(f"Goal Nudge watcher running — sync on http://127.0.0.1:{config['port']}/settings")
    Watcher(root)
    root.mainloop()


if __name__ == "__main__":
    main()
