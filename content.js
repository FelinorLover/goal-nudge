// Draws the overlay when the background script says so. Lives in a shadow root
// so the page's CSS can't touch it and ours can't leak out.

const browser = globalThis.browser ?? globalThis.chrome;

let host = null;
let timer = null;

function hide() {
  if (timer) clearInterval(timer);
  timer = null;
  if (host) host.remove();
  host = null;
  document.documentElement.style.overflow = "";
}

function show({ goals, delaySeconds, domain, cooldownMinutes, note }) {
  if (host) return; // already up
  for (const v of document.querySelectorAll("video")) v.pause();
  host = document.createElement("div");
  host.id = "goal-nudge-host";
  const root = host.attachShadow({ mode: "closed" });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .backdrop {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(10, 12, 18, 0.96);
        display: flex; align-items: center; justify-content: center;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #e5e7eb;
        animation: fade 250ms ease-out;
      }
      @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
      .card { max-width: 560px; width: 90%; padding: 40px; }
      h1 { font-size: 26px; font-weight: 600; margin: 0 0 6px; color: #fff; }
      .sub { color: #9ca3af; font-size: 15px; margin: 0 0 28px; }
      ul { list-style: none; padding: 0; margin: 0 0 32px; }
      li {
        padding: 12px 16px; margin-bottom: 8px; border-radius: 8px;
        background: rgba(255,255,255,0.05); border-left: 3px solid #f59e0b;
        font-size: 17px; line-height: 1.4;
      }
      .row { display: flex; gap: 12px; }
      button {
        flex: 1; padding: 14px 18px; border-radius: 8px; border: 0;
        font-size: 15px; font-weight: 600; cursor: pointer;
        font-family: inherit;
      }
      .primary { background: #f59e0b; color: #111827; }
      .primary:hover { background: #fbbf24; }
      .ghost { background: transparent; color: #9ca3af; border: 1px solid #374151; }
      .ghost:hover:not(:disabled) { color: #e5e7eb; border-color: #6b7280; }
      .ghost:disabled { opacity: 0.4; cursor: not-allowed; }
      .foot { margin-top: 18px; font-size: 12px; color: #6b7280; text-align: center; }
    </style>
    <div class="backdrop">
      <div class="card">
        <h1>Are you sure?</h1>
        <p class="sub">You're on <b>${escapeHtml(domain)}</b>.${note ? ` <i>${escapeHtml(note)}</i>` : ""} You said you wanted to:</p>
        <ul>${goals.map((g) => `<li>${escapeHtml(g)}</li>`).join("")}</ul>
        <div class="row">
          <button class="primary" id="close">Close this tab</button>
          <button class="ghost" id="continue" disabled>Continue anyway (${delaySeconds})</button>
        </div>
        <p class="foot">${domain === "youtube.com" ? "Continuing only clears this video — the next one gets judged on its own." : `Continuing silences ${escapeHtml(domain)} for ${cooldownMinutes} minutes.`}</p>
      </div>
    </div>`;

  const cont = root.getElementById("continue");
  let left = delaySeconds;
  timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(timer);
      timer = null;
      cont.disabled = false;
      cont.textContent = "Continue anyway";
    } else {
      cont.textContent = `Continue anyway (${left})`;
    }
  }, 1000);

  cont.addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "continue", domain, cooldownMinutes, url: location.href });
    hide();
  });
  root.getElementById("close").addEventListener("click", () => {
    browser.runtime.sendMessage({ type: "close", domain });
  });

  document.documentElement.style.overflow = "hidden";
  document.documentElement.appendChild(host);
  browser.runtime.sendMessage({ type: "shown", domain });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// YouTube's description box fills in a beat after navigation; wait briefly for it.
async function describe() {
  for (let i = 0; i < 10; i++) {
    const el = document.querySelector("#description-inline-expander, #description");
    const text = el && el.innerText.trim();
    if (text) return text.slice(0, 800);
    await new Promise((r) => setTimeout(r, 250));
  }
  return "";
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "show") show(msg);
  else if (msg.type === "hide") hide();
  else if (msg.type === "describe") {
    describe().then(sendResponse);
    return true; // async response
  }
});

browser.runtime.sendMessage({ type: "ready" });
