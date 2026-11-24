const $ = (id) => document.getElementById(id);
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmtMin = (sec) => Math.round((sec / 60) * 10) / 10;
const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
};

function recheck() {
  try {
    Promise.resolve(browser.runtime.sendMessage({ type: "recheck" })).catch(() => {});
  } catch (e) {}
}

function showBackupMsg(text, bad) {
  const el = $("backupMsg");
  el.textContent = text;
  el.classList.toggle("bad", !!bad);
  el.hidden = false;
}

async function render() {
  const [s, st, usage, reasons] = await Promise.all([loadSettings(), loadStats(), loadUsage(), loadReasons()]);
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
  $("escalate").checked = s.escalate;
  $("maxDelaySeconds").value = s.maxDelaySeconds;
  $("requireReason").checked = s.requireReason;
  $("minReasonChars").value = s.minReasonChars;
  $("budgets").value = formatBudgets(s.budgets);
  $("whEnabled").checked = s.workHours.enabled;
  $("whStart").value = s.workHours.start;
  $("whEnd").value = s.workHours.end;
  $("days").innerHTML = DAY_NAMES.map(
    (n, i) => `<label class="inline"><input type="checkbox" data-day="${i}" ${s.workHours.days.includes(i) ? "checked" : ""}> ${n}</label>`
  ).join("");

  const budgetRows = Object.entries(s.budgets || {});
  const seconds = (usage && usage.seconds) || {};
  $("budgetToday").innerHTML = budgetRows.length
    ? budgetRows
        .map(([d, limit]) => {
          const used = seconds[d] || 0;
          const over = used / 60 >= limit;
          return `<div class="budget-row"><span>${esc(d)}</span><span class="${over ? "over" : "muted"}">${fmtMin(used)} / ${esc(limit)} min</span></div>`;
        })
        .join("")
    : `<p class="hint">No budgets set.</p>`;

  $("totals").textContent = `Shown ${st.shown} times · continued ${st.continued} · closed ${st.closed}`;
  const rows = Object.entries(st.byDomain).sort((a, b) => b[1].shown - a[1].shown);
  $("byDomain").innerHTML = rows.length
    ? `<tr><th>Site</th><th>Shown</th><th>Continued</th><th>Closed</th></tr>` +
      rows.map(([d, v]) => `<tr><td>${esc(d)}</td><td>${v.shown}</td><td>${v.continued}</td><td>${v.closed}</td></tr>`).join("")
    : "";

  const recent = (reasons || []).slice(-20).reverse();
  $("reasons").innerHTML = recent.length
    ? recent
        .map((r) => {
          const when = new Date(r.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          return `<li>${esc(when)} · ${esc(r.domain)} — ${esc(r.reason)}</li>`;
        })
        .join("")
    : `<li class="empty">No reasons logged yet. Turn on "Require a typed reason" and they will show up here.</li>`;
}

$("save").addEventListener("click", async () => {
  const errEl = $("saveErr");
  errEl.hidden = true;
  try {
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
    s.escalate = $("escalate").checked;
    s.maxDelaySeconds = clamp($("maxDelaySeconds").value, 5, 600, 120);
    s.requireReason = $("requireReason").checked;
    s.minReasonChars = clamp($("minReasonChars").value, 1, 200, 8);
    s.budgets = parseBudgets($("budgets").value);
    s.workHours = {
      enabled: $("whEnabled").checked,
      start: $("whStart").value || "09:00",
      end: $("whEnd").value || "18:00",
      days: [...document.querySelectorAll("#days input:checked")].map((el) => Number(el.dataset.day)),
    };
    await saveSettings(s);
    pushToDesktop(s);
    recheck();
    $("saved").classList.add("on");
    setTimeout(() => $("saved").classList.remove("on"), 1500);
    render();
  } catch (e) {
    errEl.textContent = `Not saved: ${(e && e.message) || e}`;
    errEl.hidden = false;
  }
});

$("resetStats").addEventListener("click", async () => {
  await saveStats(JSON.parse(JSON.stringify(DEFAULTS.stats)));
  await clearReasons();
  render();
});

$("exportBtn").addEventListener("click", async () => {
  try {
    const data = exportSettings(await loadSettings());
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "goal-nudge-settings.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showBackupMsg("Exported goal-nudge-settings.json");
  } catch (e) {
    showBackupMsg((e && e.message) || String(e), true);
  }
});

$("importBtn").addEventListener("click", async () => {
  const file = $("importFile").files && $("importFile").files[0];
  if (!file) return showBackupMsg("Choose a settings file first.", true);
  try {
    const partial = parseImport(await file.text());
    const merged = { ...(await loadSettings()), ...partial };
    await saveSettings(merged);
    pushToDesktop(merged);
    recheck();
    $("importFile").value = "";
    await render();
    const n = Object.keys(partial).length;
    showBackupMsg(`Imported ${n} setting${n === 1 ? "" : "s"}`);
  } catch (e) {
    showBackupMsg((e && e.message) || String(e), true);
  }
});

render();
