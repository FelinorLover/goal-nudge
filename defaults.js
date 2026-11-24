// Shared default settings. Loaded by background, options and popup.
// Chrome exposes the promise-based API as `chrome`; Firefox/Zen as `browser`.
const browser = globalThis.browser ?? globalThis.chrome;
const DEFAULTS = {
  goals: [
    "Example: finish the side project by December",
    "Example: read 20 pages a day",
  ],
  // Hostnames. A trigger matches the host itself and any subdomain.
  triggers: [
    "youtube.com",
    "reddit.com",
    "x.com",
    "twitter.com",
    "twitch.tv",
    "tiktok.com",
    "instagram.com",
    "facebook.com",
    "netflix.com",
    "roblox.com",
  ],
  // URL substrings that are never nagged, e.g. "youtube.com/@SomeChannel".
  allow: [],
  cooldownMinutes: 15,
  delaySeconds: 5,
  workHours: { enabled: false, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5] },
  pausedUntil: 0,
  // Smart YouTube: judge whether a watch page is educational before nagging.
  // Free tier uses YouTube's own category + keywords; an optional Claude API key upgrades the judgement.
  smartYouTube: true,
  apiKey: "",
  model: "claude-opus-5",
  // Desktop watcher (ignored if it isn't running).
  watchDiscordVoice: true,
  watchSteam: true,
  steamAllow: ["blender", "aseprite", "wallpaper engine", "obs"],
  games: [
    "RobloxPlayerBeta.exe",
    "VALORANT-Win64-Shipping.exe",
    "LeagueClient.exe",
    "League of Legends.exe",
  ],
  stats: { shown: 0, continued: 0, closed: 0, byDomain: {} },
};

async function loadSettings() {
  const stored = await browser.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

async function saveSettings(settings) {
  await browser.storage.local.set({ settings });
}

// Mirror the goals/pause/timing to the desktop watcher, if it's running.
// Fire-and-forget: the extension works fine without it.
const DESKTOP_SYNC_URL = "http://127.0.0.1:47831/settings";

async function pushToDesktop(settings) {
  const { goals, pausedUntil, workHours, delaySeconds, cooldownMinutes,
          watchDiscordVoice, watchSteam, steamAllow, games } = settings;
  try {
    await fetch(DESKTOP_SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goals, pausedUntil, workHours, delaySeconds, cooldownMinutes,
                             watchDiscordVoice, watchSteam, steamAllow, games }),
    });
  } catch {
    // watcher not running
  }
}
