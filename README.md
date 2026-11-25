# Goal Nudge

A Zen/Firefox extension (Manifest V2, same setup as `speed-control-extension`).
You write your goals down; when you open a site on your distraction list, a
full-page overlay shows the goals and asks whether you'd rather work on them.

- **Close this tab** — does what it says.
- **Continue anyway** — unlocks after a short countdown (default 5s) and
  silences that site for a cooldown (default 15 min).
- Pause everything from the toolbar popup: 30m, 1h, 3h, 8h, the rest of today,
  or a week — with **Resume now** to end it early.
- Optional "only during these hours" schedule, and an allow-list for URLs you
  need (a specific channel, a subreddit).
- Stats: how often it fired and what you chose, per site.
- **Escalating friction** — every "Continue anyway" today on a site makes that
  site's next countdown longer (5s → 10s → 20s → … capped at 2 min by default).
  Resets at midnight.
- **Daily budgets** — give a site minutes per day (`youtube.com 30`). Only time
  on pages that *would* have nagged counts (educational YouTube doesn't). Once
  it's used up the overlay returns and "Continue anyway" only buys 5 minutes.
- **Type a reason to continue** (optional) — Continue stays locked until you've
  typed a few words; reasons are listed in Settings so you can read them back.
- **Export / import** settings as a JSON file. The API key and pause state are
  never exported.
- **Synced settings** — goals, sites, budgets etc. live in `storage.sync`, so
  they follow your browser account across machines. The API key, pause state,
  stats and usage stay on the device.
- **Smart YouTube** — watch pages are judged before the overlay appears.
  Free by default: the extension reads YouTube's own category (Education,
  Gaming, Entertainment…), tags and description from the watch page and
  applies a few rules — anything mentioning one of your goals passes; Gaming /
  Entertainment / Music etc. or an entertainment-flavoured title gets nagged;
  Education / Science & Tech / Howto or tutorial-ish wording passes; otherwise
  it nags. The reason shows on the overlay. Optionally paste a Claude API key
  in Settings and Claude makes the call instead (`claude-opus-5`, low effort,
  ~250 tokens a video). Home feed and Shorts always nag; search, channel and
  playlist pages never do. Verdicts are cached per video.

## Install

- **Firefox / Zen** — [Add to Firefox](https://addons.mozilla.org/firefox/addon/goal-nudge/) (signed by Mozilla, updates automatically).
- **Chrome / Edge / Brave** — download `goal-nudge-chrome.zip` from the [latest release](https://github.com/FelinorLover/goal-nudge/releases/latest), unzip, then see [Chrome / Edge / Brave](#chrome--edge--brave) below.
- **Windows desktop watcher** (games + Discord calls, optional) — `GoalNudgeWatcher.exe` on the same release page.

## Chrome / Edge / Brave

`manifest.chrome.json` is the Manifest V3 version of the same extension; the
code runs unchanged on both. Build both zips with:

```bash
python build.py
```

Send `dist/goal-nudge-chrome.zip` to whoever. They unzip it, open
`chrome://extensions`, turn on **Developer mode** (top right), click
**Load unpacked** and pick the folder. Nothing to sign.

## Files

| File | Role |
| --- | --- |
| `background.js` | Watches tab URLs, decides whether to nag, tracks cooldowns and stats (service worker on Chrome) |
| `content.js` | Draws the overlay (closed shadow root) and reports your choice |
| `defaults.js` | Default settings + `loadSettings` / `saveSettings`, shared by everything |
| `options.*` | Settings page (goals, sites, allow-list, timing, schedule, stats) |
| `popup.*` | Toolbar popup: goals at a glance, pause/resume, open settings |
| `manifest.json` / `manifest.chrome.json` | Firefox (MV2) and Chrome (MV3) manifests |
| `build.py` | Zips both variants into `dist/` |

## Install in Zen (temporary)

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick `manifest.json` in this folder.
3. Click the toolbar icon → **Settings**, replace the example goals.

Temporary add-ons vanish when Zen restarts. For a permanent install, zip the
folder contents and sign it unlisted on AMO — the steps are in
`../speed-control-extension/README.md` and are identical.

## Desktop watcher (games + Discord voice)

`watcher/watcher.py` covers what the browser can't see. Python 3, stdlib only.

- **Games** — any Steam game (via Steam's `RunningAppID`, name looked up from
  the app manifest) plus any exe listed under `"games"`. "Quit the game"
  force-kills it. Steam apps whose store genres are *all* creative-tool genres
  (Animation & Modeling, Design & Illustration, Utilities…) are skipped, so
  Blender and Aseprite never nag; the verdict is cached per appid in
  `steam_is_tool`. Add anything else to `steam_allow` (app ID or name fragment).
- **Discord voice calls** — detected the moment Discord opens the microphone,
  read from the registry store behind Windows' "mic in use" tray icon
  (`CapabilityAccessManager\ConsentStore\microphone`). Works for Discord,
  PTB, Canary and Vesktop. "I'll leave the call" gives you
  `leave_grace_minutes` (default 2) and nags again if you're still in it.
- Discord voice watching, game watching, the Steam allow list and the non-Steam
  game list are all toggles on the extension's settings page (**Desktop
  watcher**), pushed to the watcher when you save.
- Escalating friction and the optional typed reason work in the watcher too
  (reasons are appended to `reasons.log` next to the exe/script). Daily budgets
  are browser-only.
- Same countdown / cooldown / pause / work-hours rules as the extension. The
  extension pushes goals, pause and timing to `http://127.0.0.1:47831/settings`
  whenever you save or pause, so you only edit them in one place. `config.json`
  is created on first run; `games`, `overlay_monitor`, `beep` etc. live there.

```bash
python watcher/watcher.py --demo --monitor 1
```
shows the overlay once (on the second monitor) so you can see it.

Run for real with `wscript watcher/start-watcher.vbs` (no console), or make it
start at login:

```bash
powershell -ExecutionPolicy Bypass -File watcher/install-startup.ps1
```

### Giving it to someone without Python

`python build.py --exe` packages the watcher as `dist/GoalNudgeWatcher.exe`
(PyInstaller, ~12 MB). They put it anywhere, double-click it to run — it makes
`config.json` next to itself — and run it once with `--install-startup` to
add a Startup-folder shortcut:

```bash
GoalNudgeWatcher.exe --install-startup
```

Windows SmartScreen will warn about an unsigned exe the first time; "More
info → Run anyway".

Caveat: a game in *exclusive* fullscreen may sit above the overlay — you'll
still hear the beep. Borderless/windowed is fine.

## Ideas for later

- macOS / Linux watcher (currently Windows-only: registry, WASAPI, Win32).
