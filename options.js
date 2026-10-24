import {
  DEFAULT_BASE, createClient, describeError, loadSettings, normalizeBase, removeApiKey, saveSettings,
} from "./shared.js";

const $ = (id) => document.getElementById(id);
const baseEl = $("base");
const keyEl = $("key");
const msg = $("msg");
let savedKey = "";

function say(text, kind = "") {
  msg.textContent = text;
  msg.className = `msg ${kind}`.trim();
}

function reflectKey() {
  $("key-hint").textContent = savedKey
    ? "A key is saved. Leave this blank to keep it, or enter a new one to replace it."
    : "Paste the key you set with `wrangler secret put API_KEY`.";
  $("forget").hidden = !savedKey;
}

async function load() {
  const s = await loadSettings();
  baseEl.value = s.base === DEFAULT_BASE ? new URL(s.base).host : s.base;
  savedKey = s.apiKey;
  reflectKey();
  $("origin").textContent = `chrome-extension://${chrome.runtime.id}`;
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const base = normalizeBase(baseEl.value);
  if (!base.ok) return say(base.error, "err");
  const next = { base: base.base };
  if (keyEl.value.trim()) next.apiKey = keyEl.value.trim();
  await saveSettings(next);
  if (next.apiKey) savedKey = next.apiKey;
  keyEl.value = "";
  baseEl.value = new URL(base.base).host;
  reflectKey();
  say("Saved.", "ok");
});

$("test").addEventListener("click", async () => {
  const base = normalizeBase(baseEl.value);
  if (!base.ok) return say(base.error, "err");
  const apiKey = keyEl.value.trim() || savedKey;
  if (!apiKey) return say("Enter an API key first.", "err");
  say("Testing…");
  try {
    await createClient({ base: base.base, apiKey }).list(1);
    say("Connected. The domain and key work.", "ok");
  } catch (err) {
    say(describeError(err, base.base), "err");
  }
});

$("forget").addEventListener("click", async () => {
  await removeApiKey();
  savedKey = "";
  reflectKey();
  say("Saved key removed.", "ok");
});

$("copy-origin").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("origin").textContent);
    say("Address copied.", "ok");
  } catch {
    say("Could not copy. Select the address and copy it manually.", "err");
  }
});

load();
