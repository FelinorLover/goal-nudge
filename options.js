const $ = (id) => document.getElementById(id);
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

async function render() {
  const s = await loadSettings();
  $("goals").value = s.goals.join("\n");
  $("triggers").value = s.triggers.join("\n");
  $("allow").value = s.allow.join("\n");
  $("smartYouTube").checked = s.smartYouTube;
  $("apiKey").value = s.apiKey;
  $("model").value = s.model;
  $("watchDiscordVoice").checked = s.watchDiscordVoice;
  $("watchSteam").checked = s.watchSteam;
  $("steamAllow").value = s.steamAllow.join("\n");
  $("games").value = s.games.join("\n");
  $("delaySeconds").value = s.delaySeconds;
  $("cooldownMinutes").value = s.cooldownMinutes;
  $("whEnabled").checked = s.workHours.enabled;
  $("whStart").value = s.workHours.start;
  $("whEnd").value = s.workHours.end;
  $("days").innerHTML = DAY_NAMES.map(
    (n, i) => `<label class="inline"><input type="checkbox" data-day="${i}" ${s.workHours.days.includes(i) ? "checked" : ""}> ${n}</label>`
  ).join("");

  const st = s.stats;
  $("totals").textContent = `Shown ${st.shown} times · continued ${st.continued} · closed ${st.closed}`;
  const rows = Object.entries(st.byDomain).sort((a, b) => b[1].shown - a[1].shown);
  $("byDomain").innerHTML = rows.length
    ? `<tr><th>Site</th><th>Shown</th><th>Continued</th><th>Closed</th></tr>` +
      rows.map(([d, v]) => `<tr><td>${esc(d)}</td><td>${v.shown}</td><td>${v.continued}</td><td>${v.closed}</td></tr>`).join("")
    : "";
}

$("save").addEventListener("click", async () => {
  const s = await loadSettings();
  s.goals = lines($("goals").value);
  s.triggers = lines($("triggers").value).map((t) =>
    t.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")
  );
  s.allow = lines($("allow").value);
  s.smartYouTube = $("smartYouTube").checked;
  s.apiKey = $("apiKey").value.trim();
  s.model = $("model").value.trim() || "claude-opus-5";
  s.watchDiscordVoice = $("watchDiscordVoice").checked;
  s.watchSteam = $("watchSteam").checked;
  s.steamAllow = lines($("steamAllow").value);
  s.games = lines($("games").value);
  s.delaySeconds = Math.max(0, Number($("delaySeconds").value) || 0);
  s.cooldownMinutes = Math.max(1, Number($("cooldownMinutes").value) || 15);
  s.workHours = {
    enabled: $("whEnabled").checked,
    start: $("whStart").value || "09:00",
    end: $("whEnd").value || "18:00",
    days: [...document.querySelectorAll("#days input:checked")].map((el) => Number(el.dataset.day)),
  };
  await saveSettings(s);
  pushToDesktop(s);
  browser.runtime.sendMessage({ type: "recheck" });
  $("saved").classList.add("on");
  setTimeout(() => $("saved").classList.remove("on"), 1500);
  render();
});

$("resetStats").addEventListener("click", async () => {
  const s = await loadSettings();
  s.stats = { shown: 0, continued: 0, closed: 0, byDomain: {} };
  await saveSettings(s);
  render();
});

render();
