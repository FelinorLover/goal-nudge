// Decides, for every tab navigation, whether the overlay should be shown.
// The content script never decides anything itself; it only asks and obeys.

// Chrome runs this as a service worker: pull in the shared file ourselves.
// (Firefox lists defaults.js in the manifest, where importScripts doesn't exist.)
if (typeof importScripts === "function") importScripts("defaults.js");

// Cooldowns live in storage rather than memory: Chrome's service worker is
// killed after ~30s idle and would forget them.
async function getCooldowns() {
  const { cooldowns = {} } = await browser.storage.local.get("cooldowns");
  return cooldowns;
}

async function setCooldown(key, until) {
  const cooldowns = await getCooldowns();
  const now = Date.now();
  for (const k of Object.keys(cooldowns)) if (cooldowns[k] < now) delete cooldowns[k];
  cooldowns[key] = until;
  await browser.storage.local.set({ cooldowns });
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function matchedTrigger(host, triggers) {
  return triggers.find((t) => host === t || host.endsWith("." + t)) || null;
}

function isAllowed(url, allow) {
  return allow.some((a) => a && url.includes(a));
}

function insideWorkHours(wh, now = new Date()) {
  if (!wh.enabled) return true;
  if (!wh.days.includes(now.getDay())) return false;
  const [sh, sm] = wh.start.split(":").map(Number);
  const [eh, em] = wh.end.split(":").map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end;
}

async function evaluate(tabId, url) {
  if (!url || !/^https?:/.test(url)) return;
  const s = await loadSettings();
  const cooldowns = await getCooldowns();
  const host = hostOf(url);
  const trigger = matchedTrigger(host, s.triggers);

  let suppress =
    !trigger ||
    Date.now() < s.pausedUntil ||
    !insideWorkHours(s.workHours) ||
    isAllowed(url, s.allow) ||
    (cooldowns[trigger] || 0) > Date.now();

  let note = "";
  if (!suppress && trigger === "youtube.com" && s.smartYouTube) {
    const verdict = await youtubeVerdict(tabId, url, s, cooldowns);
    // The tab may have moved on while we were classifying; a newer evaluate() owns it now.
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || tab.url !== url) return;
    suppress = !verdict.nag;
    note = verdict.note || "";
  }

  const msg = suppress
    ? { type: "hide" }
    : { type: "show", goals: s.goals, delaySeconds: s.delaySeconds, domain: trigger, cooldownMinutes: s.cooldownMinutes, note };

  try {
    await browser.tabs.sendMessage(tabId, msg);
  } catch {
    // No content script on this page yet (still loading, or a privileged page). It will ask when ready.
  }
}

// ---- Smart YouTube -------------------------------------------------------
// Home feed and Shorts always nag. Search, channel and playlist pages never do
// (that's intent, not drift). Watch pages get classified — by YouTube's own
// category + keywords for free, or by Claude if an API key is set — cached per video.

const pendingVerdicts = new Map(); // videoId -> Promise

// Cooldown key for a YouTube page: one per video, plus one each for the home feed and Shorts.
function youtubeKey(url) {
  const u = new URL(url);
  if (u.pathname === "/watch") return `yt:${u.searchParams.get("v")}`;
  if (u.pathname.startsWith("/shorts/")) return "yt:shorts";
  return "yt:home";
}

async function youtubeVerdict(tabId, url, s, cooldowns) {
  const u = new URL(url);
  if ((cooldowns[youtubeKey(url)] || 0) > Date.now()) return { nag: false };
  if (u.pathname === "/") return { nag: true, note: "The home feed is the rabbit hole." };
  if (u.pathname.startsWith("/shorts/")) return { nag: true, note: "Shorts." };
  if (u.pathname !== "/watch" || !u.searchParams.get("v")) return { nag: false };

  const id = u.searchParams.get("v");
  const { ytVerdicts = {} } = await browser.storage.local.get("ytVerdicts");
  if (ytVerdicts[id]) return verdictToResult(ytVerdicts[id]);

  if (!pendingVerdicts.has(id)) {
    pendingVerdicts.set(id, classifyVideo(tabId, id, s).finally(() => pendingVerdicts.delete(id)));
  }
  const v = await pendingVerdicts.get(id);
  if (!v) return { nag: true }; // classification failed — fall back to the plain nag

  ytVerdicts[id] = v;
  const keys = Object.keys(ytVerdicts); // keep the cache bounded
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete ytVerdicts[k];
  await browser.storage.local.set({ ytVerdicts });
  return verdictToResult(v);
}

function verdictToResult(v) {
  return v.educational ? { nag: false } : { nag: true, note: v.reason };
}

// Pull title, channel, category, keywords and description straight out of the
// watch page's embedded player JSON. No API, no key.
async function fetchVideoInfo(id) {
  const html = await fetch(`https://www.youtube.com/watch?v=${id}`, { credentials: "omit" })
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  const grab = (key) => {
    const m = html.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? JSON.parse(`"${m[1]}"`) : "";
  };
  const kw = html.match(/"keywords":\[((?:"(?:[^"\\]|\\.)*",?)*)\]/);
  return {
    title: grab("title"),
    channel: grab("ownerChannelName") || grab("author"),
    category: grab("category"),
    keywords: kw ? JSON.parse(`[${kw[1]}]`) : [],
    description: grab("shortDescription"),
  };
}

const EDU_CATEGORIES = new Set(["Education", "Science & Technology", "Howto & Style"]);
const FUN_CATEGORIES = new Set(["Gaming", "Entertainment", "Comedy", "Music", "Film & Animation", "Sports", "Pets & Animals", "Autos & Vehicles"]);
// Strong enough to override a Gaming/Entertainment category when they appear in the title.
const TUTORIAL_WORDS = /\b(tutorial|how to|course|lesson|lecture|guide|learn|learning|beginners?|for beginners|masterclass|crash course|step by step|fundamentals|introduction to|intro to|explained)\b/i;
const EDU_WORDS = /\b(tutorial|how to|how i|course|lesson|lecture|explained|explain|guide|learn|learning|beginner|masterclass|walkthrough|crash course|deep dive|documentary|101|step by step|for beginners|fundamentals|introduction to|intro to|TED|tips|technique|theory|breakdown|analysis)\b/i;
const FUN_WORDS = /\b(reaction|reacts?|react to|funny|meme|memes|prank|challenge|vlog|drama|exposed|tier list|highlights|montage|compilation|gameplay|let's play|playthrough|trailer|official video|lyrics|full episode|unboxing|asmr|shorts|try not to)\b/i;

const GOAL_STOP = new Set(["example", "finish", "about", "every", "really", "which", "their", "there", "would", "should",
  "could", "maybe", "start", "month", "week", "daily", "pages", "hours", "minutes", "before", "after", "until", "december",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "project", "better",
  "things", "something", "everyday", "practice", "working", "towards"]);

function heuristicVerdict(info, goals) {
  const text = `${info.title} ${info.keywords.join(" ")} ${info.description.slice(0, 500)}`;
  // Goal words: 5+ letters, whole-word, matched against title + tags only (descriptions mention everything).
  const goalWords = goals.flatMap((g) => g.toLowerCase().match(/[a-z][a-z0-9+#]{4,}/g) || [])
    .filter((w) => !GOAL_STOP.has(w));
  const headline = `${info.title} ${info.keywords.join(" ")}`.toLowerCase();
  if (goalWords.some((w) => new RegExp(`\\b${w.replace(/[+#]/g, "\\$&")}\\b`).test(headline))) {
    return { educational: true, reason: "Looks related to one of your goals." };
  }
  if (TUTORIAL_WORDS.test(info.title) && !FUN_WORDS.test(info.title)) {
    return { educational: true, reason: "The title says it's a tutorial." };
  }
  if (FUN_CATEGORIES.has(info.category)) {
    return { educational: false, reason: `YouTube files this under ${info.category}.` };
  }
  if (FUN_WORDS.test(info.title)) {
    return { educational: false, reason: "The title reads like entertainment." };
  }
  if (EDU_CATEGORIES.has(info.category)) {
    return { educational: true, reason: `YouTube files this under ${info.category}.` };
  }
  if (EDU_WORDS.test(text)) {
    return { educational: true, reason: "Looks like a tutorial or explainer." };
  }
  return { educational: false, reason: `Nothing about this says it teaches anything (${info.category || "uncategorised"}).` };
}

async function classifyVideo(tabId, id, s) {
  const info = await fetchVideoInfo(id);
  if (!info.title) {
    // Page fetch failed (offline, consent wall...). Fall back to oEmbed + the tab's description.
    const meta = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!meta) return null;
    info.title = meta.title;
    info.channel = meta.author_name;
    info.description = await browser.tabs.sendMessage(tabId, { type: "describe" }).catch(() => "");
  }

  if (!s.apiKey) {
    const v = heuristicVerdict(info, s.goals);
    return { ...v, title: info.title };
  }

  const video = [
    `Title: ${info.title}`,
    `Channel: ${info.channel || "(unknown)"}`,
    `YouTube category: ${info.category || "(unknown)"}`,
    `Tags: ${info.keywords.slice(0, 20).join(", ") || "(none)"}`,
    `Description: ${(info.description || "(unavailable)").slice(0, 800)}`,
  ].join("\n");

  const system = [
    "You judge whether a YouTube video is educational: it teaches a skill, explains how something works,",
    "is a lecture, course, tutorial, walkthrough of a craft, documentary, or otherwise leaves the viewer",
    "more capable or knowledgeable. Entertainment, gaming, reactions, vlogs, drama, memes, music, sports,",
    "commentary and content-about-content are not educational, even when framed as informative.",
    "Be strict: when in doubt, it is not educational. Content directly relevant to the viewer's goals",
    "counts as educational.",
    "",
    "Viewer's goals:",
    ...s.goals.map((g) => `- ${g}`),
  ].join("\n");

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": s.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: s.model || "claude-opus-5",
        max_tokens: 256,
        system,
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                educational: { type: "boolean" },
                reason: { type: "string", description: "One short sentence, addressed to the viewer." },
              },
              required: ["educational", "reason"],
              additionalProperties: false,
            },
          },
        },
        messages: [{ role: "user", content: video }],
      }),
    });
    if (!r.ok) {
      console.warn("Goal Nudge: Claude API error", r.status, await r.text());
      return null;
    }
    const data = await r.json();
    if (data.stop_reason === "refusal") return null;
    const text = data.content.find((b) => b.type === "text")?.text;
    const v = JSON.parse(text);
    return { educational: !!v.educational, reason: String(v.reason || ""), title: info.title };
  } catch (e) {
    console.warn("Goal Nudge: classification failed", e);
    return null;
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") evaluate(tabId, tab.url);
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await browser.tabs.get(tabId);
  evaluate(tabId, tab.url);
});

async function bump(stat, domain) {
  const s = await loadSettings();
  s.stats[stat] = (s.stats[stat] || 0) + 1;
  const d = (s.stats.byDomain[domain] ||= { shown: 0, continued: 0, closed: 0 });
  d[stat] = (d[stat] || 0) + 1;
  await saveSettings(s);
}

browser.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab && sender.tab.id;
  switch (msg.type) {
    case "ready":
      if (tabId != null) evaluate(tabId, sender.tab.url);
      break;
    case "shown":
      bump("shown", msg.domain);
      break;
    case "continue":
      // YouTube is judged per video, so "continue" only clears that video (or the home feed / Shorts),
      // never the whole site.
      setCooldown(msg.domain === "youtube.com" ? youtubeKey(msg.url) : msg.domain,
        Date.now() + msg.cooldownMinutes * 60 * 1000);
      bump("continued", msg.domain);
      break;
    case "close":
      bump("closed", msg.domain);
      if (tabId != null) browser.tabs.remove(tabId);
      break;
    case "recheck":
      // Settings changed (popup/options) — re-evaluate the active tab.
      browser.tabs.query({ active: true, currentWindow: true }).then(([t]) => t && evaluate(t.id, t.url));
      break;
  }
});

// Verdicts depend on the rules above; start fresh whenever the extension is (re)loaded.
browser.runtime.onInstalled.addListener(() => browser.storage.local.remove("ytVerdicts"));
