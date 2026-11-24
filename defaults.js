// Shared default settings + storage helpers. Loaded by background, options and popup.
// Chrome exposes the promise-based API as `chrome`; Firefox/Zen as `browser`.
// Plain script on purpose (no modules): Firefox lists it in the manifest, Chrome's worker importScripts() it.
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
  // Each "Continue anyway" today on a site makes that site's countdown longer:
  // delay = min(maxDelaySeconds, delaySeconds * 2 ** continuesToday). Example base 5: 5, 10, 20, 40, 80, 120...
  escalate: true,
  maxDelaySeconds: 120,
  // Continuing needs a typed reason of at least minReasonChars (trimmed) characters.
  requireReason: false,
  minReasonChars: 8,
  // Minutes per day per trigger domain, e.g. { "youtube.com": 30 }. Over budget => the overlay comes back.
  budgets: {},
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

// ---- Storage layout --------------------------------------------------------
// sync  `settings`      every setting except the three below (falls back to local `settings` if sync is unavailable)
// local `localSettings` { apiKey, pausedUntil }  - the key must never sync; pause is per device
// local `stats`         counters (written on every nag, so never in sync)
// local `usage`, `reasonLog`, `cooldowns`, `ytVerdicts`: background bookkeeping
// Legacy installs kept everything in one local `settings` blob; loadSettings() migrates it on first read.

const GN_LOCAL_ONLY = ["apiKey", "pausedUntil"];
const GN_NOT_SHARED = [...GN_LOCAL_ONLY, "stats"];

function gnClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function gnPickShared(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of Object.keys(obj)) if (!GN_NOT_SHARED.includes(k)) out[k] = obj[k];
  return out;
}

function gnMergeStats(st) {
  const base = gnClone(DEFAULTS.stats);
  if (!st || typeof st !== "object") return base;
  const byDomain = st.byDomain && typeof st.byDomain === "object" ? st.byDomain : {};
  return { ...base, ...st, byDomain: { ...byDomain } };
}

// { ok, value }: ok=false when storage.sync is missing or throws (e.g. Firefox with sync switched off).
async function gnReadSync() {
  const area = browser.storage && browser.storage.sync;
  if (!area) return { ok: false };
  try {
    const r = await area.get("settings");
    return { ok: true, value: r ? r.settings : undefined };
  } catch {
    return { ok: false };
  }
}

async function loadSettings() {
  const local = await browser.storage.local.get(["settings", "localSettings", "stats"]);
  const legacy = local.settings && typeof local.settings === "object" ? local.settings : undefined;
  const sync = await gnReadSync();

  let shared;
  let localSettings = local.localSettings;
  let stats = local.stats;

  // Pull local-only parts out of an old single-blob install.
  const writes = {};
  if (legacy) {
    if (localSettings === undefined && ("apiKey" in legacy || "pausedUntil" in legacy)) {
      localSettings = { apiKey: legacy.apiKey ?? "", pausedUntil: legacy.pausedUntil ?? 0 };
      writes.localSettings = localSettings;
    }
    if (stats === undefined && legacy.stats && typeof legacy.stats === "object") {
      stats = legacy.stats;
      writes.stats = stats;
    }
  }
  if (Object.keys(writes).length) {
    try { await browser.storage.local.set(writes); } catch { /* retry on next load */ }
  }

  if (sync.ok) {
    if (sync.value !== undefined) {
      shared = sync.value;
      if (legacy) { try { await browser.storage.local.remove("settings"); } catch { /* ignore */ } }
    } else if (legacy) {
      // First load after upgrading: lift the shared part of the old blob into sync.
      shared = gnPickShared(legacy);
      try {
        await browser.storage.sync.set({ settings: shared });
        await browser.storage.local.remove("settings");
      } catch {
        // Quota or sync trouble: keep the legacy blob where it is and carry on with what we have.
      }
    } else {
      shared = {};
    }
  } else {
    // No usable sync: local `settings` doubles as the shared blob. Scrub legacy local-only keys out of it.
    shared = gnPickShared(legacy);
    if (legacy && Object.keys(legacy).some((k) => GN_NOT_SHARED.includes(k))) {
      try { await browser.storage.local.set({ settings: shared }); } catch { /* ignore */ }
    }
  }

  const ls = {};
  if (localSettings && typeof localSettings === "object") {
    for (const k of GN_LOCAL_ONLY) if (k in localSettings) ls[k] = localSettings[k];
  }
  return { ...gnClone(DEFAULTS), ...gnPickShared(shared), ...ls, stats: gnMergeStats(stats) };
}

// Throws on failure (e.g. sync quota) so the options page can tell the user.
async function saveSettings(settings) {
  const shared = gnPickShared(settings);
  let synced = false;
  const area = browser.storage && browser.storage.sync;
  if (area) {
    try {
      await area.set({ settings: shared });
      synced = true;
    } catch (e) {
      if (/quota/i.test(String((e && e.message) || e))) throw e;
      // Sync unavailable: fall through to local.
    }
  }
  if (!synced) await browser.storage.local.set({ settings: shared });

  const cur = (await browser.storage.local.get("localSettings")).localSettings || {};
  const next = { ...cur };
  for (const k of GN_LOCAL_ONLY) if (k in settings) next[k] = settings[k];
  await browser.storage.local.set({ localSettings: next });

  if (settings.stats) await saveStats(settings.stats);
}

// Stats live in local only so that bumping a counter never writes to sync.
async function loadStats() {
  const r = await browser.storage.local.get(["stats", "settings"]);
  let st = r.stats;
  if (st === undefined && r.settings && r.settings.stats) st = r.settings.stats; // not migrated yet
  return gnMergeStats(st);
}

async function saveStats(stats) {
  await browser.storage.local.set({ stats });
}

function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Today's usage; a stale date reads as empty.
async function loadUsage() {
  const { usage } = await browser.storage.local.get("usage");
  const today = todayKey();
  if (!usage || typeof usage !== "object" || usage.date !== today) {
    return { date: today, seconds: {}, continues: {} };
  }
  return {
    date: today,
    seconds: usage.seconds && typeof usage.seconds === "object" ? usage.seconds : {},
    continues: usage.continues && typeof usage.continues === "object" ? usage.continues : {},
  };
}

async function loadReasons() {
  const { reasonLog } = await browser.storage.local.get("reasonLog");
  return Array.isArray(reasonLog) ? reasonLog : [];
}

async function clearReasons() {
  await browser.storage.local.set({ reasonLog: [] });
}

// ---- Export / import -------------------------------------------------------

function exportSettings(settings) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (GN_NOT_SHARED.includes(k)) continue;
    if (settings && k in settings) out[k] = settings[k];
  }
  return { goalNudge: 1, exportedAt: new Date().toISOString(), settings: out };
}

function gnTypeOk(value, def) {
  if (Array.isArray(def)) return Array.isArray(value);
  if (def !== null && typeof def === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (typeof def === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === typeof def;
}

function gnNormDomain(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/^www\./, "");
}

const GN_DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function gnCleanBudgets(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const d = gnNormDomain(k);
    if (GN_DOMAIN_RE.test(d) && typeof v === "number" && Number.isFinite(v) && v > 0) out[d] = v;
  }
  return out;
}

function gnCleanWorkHours(wh) {
  const out = {};
  if (typeof wh.enabled === "boolean") out.enabled = wh.enabled;
  const time = /^([01]?\d|2[0-3]):[0-5]\d$/;
  if (typeof wh.start === "string" && time.test(wh.start)) out.start = wh.start;
  if (typeof wh.end === "string" && time.test(wh.end)) out.end = wh.end;
  if (Array.isArray(wh.days)) out.days = [...new Set(wh.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  return Object.keys(out).length ? { ...DEFAULTS.workHours, ...out } : undefined;
}

// Returns a sanitized PARTIAL settings object. Throws Error with a human message when nothing usable is in the text.
function parseImport(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error("That isn't valid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("That file doesn't look like exported Goal Nudge settings.");
  }
  const src = data.goalNudge && data.settings && typeof data.settings === "object" && !Array.isArray(data.settings)
    ? data.settings
    : data;

  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (GN_NOT_SHARED.includes(key) || !(key in src)) continue;
    let value = src[key];
    const def = DEFAULTS[key];
    if (!gnTypeOk(value, def)) continue;
    if (Array.isArray(def)) {
      value = value.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
    } else if (key === "budgets") {
      value = gnCleanBudgets(value);
    } else if (key === "workHours") {
      value = gnCleanWorkHours(value);
      if (!value) continue;
    } else if (typeof def === "number" && value < 0) {
      continue;
    }
    out[key] = value;
  }
  if (!Object.keys(out).length) throw new Error("No Goal Nudge settings found in that file.");
  return out;
}

// "youtube.com 30" per line (separators: space, =, :, tab) -> { "youtube.com": 30 }. Bad lines are skipped.
function parseBudgets(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    if (!line) continue;
    const parts = line.split(/[\s=:]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const domain = gnNormDomain(parts[0]);
    const minutes = Number(parts[1]);
    if (!GN_DOMAIN_RE.test(domain) || !Number.isFinite(minutes) || minutes <= 0) continue;
    out[domain] = minutes;
  }
  return out;
}

function formatBudgets(obj) {
  return Object.entries(obj || {}).map(([d, m]) => `${d} ${m}`).join("\n");
}

// ---- Desktop watcher -------------------------------------------------------
// Mirror the goals/pause/timing to the desktop watcher, if it's running.
// Fire-and-forget: the extension works fine without it.
const DESKTOP_SYNC_URL = "http://127.0.0.1:47831/settings";

async function pushToDesktop(settings) {
  const { goals, pausedUntil, workHours, delaySeconds, cooldownMinutes,
          watchDiscordVoice, watchSteam, steamAllow, games,
          escalate, maxDelaySeconds, requireReason, minReasonChars } = settings;
  try {
    await fetch(DESKTOP_SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goals, pausedUntil, workHours, delaySeconds, cooldownMinutes,
                             watchDiscordVoice, watchSteam, steamAllow, games,
                             escalate, maxDelaySeconds, requireReason, minReasonChars }),
    });
  } catch {
    // watcher not running
  }
}
