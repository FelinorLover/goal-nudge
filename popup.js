const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function pauseLabel(until) {
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? `until ${time}` : `until ${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

const fmtMin = (sec) => Math.round((sec / 60) * 10) / 10;

async function renderToday(s) {
  const entries = Object.entries(s.budgets || {});
  $("today").hidden = !entries.length;
  if (!entries.length) return;
  let seconds = {};
  try { seconds = (await loadUsage()).seconds || {}; } catch (e) {}
  $("todayList").innerHTML = entries
    .map(([d, limit]) => {
      const used = seconds[d] || 0;
      const over = used / 60 >= limit;
      return `<div class="budget-row"><span>${esc(d)}</span><span class="${over ? "over" : ""}">${fmtMin(used)} / ${esc(limit)} min</span></div>`;
    })
    .join("");
}

async function render() {
  const s = await loadSettings();
  const paused = Date.now() < s.pausedUntil;
  $("status").textContent = paused
    ? `Paused ${pauseLabel(s.pausedUntil)}`
    : `Watching ${s.triggers.length} site${s.triggers.length === 1 ? "" : "s"}`;
  $("status").classList.toggle("paused", paused);
  $("resume").hidden = !paused;
  $("pauses").hidden = paused;
  $("goals").innerHTML = s.goals.length
    ? s.goals.map((g) => `<li>${esc(g)}</li>`).join("")
    : `<li class="empty">No goals yet — add some in Settings</li>`;
  renderToday(s);
}

async function setPause(until) {
  const s = await loadSettings();
  s.pausedUntil = until;
  await saveSettings(s);
  pushToDesktop(s);
  browser.runtime.sendMessage({ type: "recheck" });
  render();
}

$("pauses").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-minutes]");
  if (!btn) return;
  const spec = btn.dataset.minutes;
  if (spec === "today") {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    setPause(end.getTime());
  } else {
    setPause(Date.now() + Number(spec) * 60 * 1000);
  }
});

$("resume").addEventListener("click", () => setPause(0));

$("settings").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

render();
