import {
  ApiError, aliasProblem, checkTabUrl, describeError, hostOf, isValidPin, randomPin, shortLabel, sortLinks,
} from "./shared.js";
import { connect } from "./auth.js";
import { drawQr, qrPngBlob, qrSvgBlob } from "./qr.js";
import { copyText, downloadBlob, flashDone, mountIcons, slug } from "./ui.js";

const $ = (id) => document.getElementById(id);
const sections = ["setup", "blocked", "failed", "ready"];

let client;
let base = "";
let currentCode = "";
let tab = { url: "", title: "" };
let locked = false;
let lastPin = ""; // kept in memory only, until the popup closes

const shortUrl = () => `${base}/${currentCode}`;

function showOnly(name) {
  for (const s of sections) $(s).hidden = s !== name;
}

function say(text, kind = "") {
  $("status").textContent = text;
  $("status").className = `msg ${kind}`.trim();
}

function setLoading(on) {
  document.body.classList.toggle("loading", on);
  $("qr-frame").classList.toggle("skeleton", on);
  $("alias").disabled = on;
  $("copy").disabled = on;
  $("qr-png").disabled = on;
  $("qr-svg").disabled = on;
  if (on) {
    $("alias").value = "Generating…";
    $("save").hidden = true;
    say("");
  }
}

function paintDestination() {
  $("dest-title").textContent = tab.title || hostOf(tab.url);
  $("dest-url").textContent = tab.url;
  $("dest-url").title = tab.url;
}

function paintQr() {
  drawQr($("qr"), shortUrl(), 288);
}

function syncSave() {
  const v = $("alias").value;
  $("save").hidden = v === currentCode || v === "" || $("alias").disabled;
}

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return { url: t?.url, title: t?.title };
}

async function generate() {
  showOnly("ready");
  locked = false;
  lastPin = "";
  $("pin-form").hidden = true;
  renderLock();
  paintDestination();
  $("prefix").textContent = `${hostOf(base)}/`;
  setLoading(true);
  try {
    const existing = await client.findByUrl(tab.url);
    let link = existing ?? (await client.create(tab.url, undefined, tab.title));
    // Older links have no title: fill it in quietly while we have the page.
    if (existing && !existing.title && tab.title) {
      link = await client.update(existing.code, { title: tab.title }).catch(() => existing);
    }
    currentCode = link.code;
    locked = !!link.locked;
    lastPin = "";
    $("alias").value = link.code;
    setLoading(false);
    renderLock();
    paintQr();
    syncSave();
    const copied = await copyText(shortUrl());
    say(`${existing ? "Existing link reused" : "Link created"}${copied ? " and copied" : ""}.`, copied ? "ok" : "");
    loadRecent();
  } catch (err) {
    // The session ended (refresh rejected or signed out elsewhere): go back to the sign-in prompt.
    if (err?.code === "signed_out") return start();
    $("failed-text").textContent = describeError(err, base);
    showOnly("failed");
  }
}

// ------------------------------------------------------------------ PIN lock

function renderLock() {
  const formOpen = !$("pin-form").hidden;
  $("pin-locked").hidden = !locked;
  $("pin-open").hidden = locked || formOpen;
  $("pin-done").hidden = !lastPin;
  $("pin-shown").textContent = lastPin;
}

function openPinForm(change) {
  $("pin-form").hidden = false;
  $("pin-save").textContent = change ? "Change PIN" : "Lock link";
  $("pin-input").value = "";
  renderLock();
  $("pin-input").focus();
}

function closePinForm() {
  $("pin-form").hidden = true;
  renderLock();
}

$("pin-open").addEventListener("click", () => openPinForm(false));
$("pin-change").addEventListener("click", () => openPinForm(true));
$("pin-cancel").addEventListener("click", closePinForm);
$("pin-random").addEventListener("click", () => {
  $("pin-input").value = randomPin();
  $("pin-input").focus();
});
$("pin-input").addEventListener("input", () => {
  $("pin-input").value = $("pin-input").value.replace(/\D/g, "").slice(0, 6);
});
$("pin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pin = $("pin-input").value;
  if (!isValidPin(pin)) return say("The PIN must be exactly 6 digits.", "err");
  $("pin-save").disabled = true;
  say("Saving…");
  try {
    await client.update(currentCode, { pin });
    locked = true;
    lastPin = pin;
    closePinForm();
    say("Link locked. Share the PIN separately.", "ok");
  } catch (err) {
    say(describeError(err, base), "err");
  } finally {
    $("pin-save").disabled = false;
  }
});

let removeTimer;
$("pin-remove").addEventListener("click", async () => {
  const btn = $("pin-remove");
  if (btn.dataset.confirm !== "1") {
    // Removing the lock makes the link open to everyone, so ask once.
    btn.dataset.confirm = "1";
    btn.textContent = "Click again to confirm";
    removeTimer = setTimeout(() => { btn.dataset.confirm = ""; btn.textContent = "Remove"; }, 4000);
    return;
  }
  clearTimeout(removeTimer);
  btn.dataset.confirm = "";
  btn.textContent = "Remove";
  try {
    await client.update(currentCode, { pin: null });
    locked = false;
    lastPin = "";
    renderLock();
    say("PIN removed. Anyone with the link can open it.", "ok");
  } catch (err) {
    say(describeError(err, base), "err");
  }
});

$("pin-copy-both").addEventListener("click", async () => {
  const ok = await copyText(`${shortUrl()}\nPIN: ${lastPin}`);
  say(ok ? "Link and PIN copied." : "Could not copy. Select the PIN and copy it manually.", ok ? "ok" : "err");
});

async function loadRecent() {
  try {
    const links = sortLinks(await client.listAll(), "newest").filter((l) => l.code !== currentCode).slice(0, 4);
    const list = $("recent-list");
    list.replaceChildren();
    for (const l of links) {
      const li = document.createElement("li");
      const text = document.createElement("div");
      text.className = "recent-text";
      const code = Object.assign(document.createElement("div"), { className: "recent-code", textContent: shortLabel(base, l.code) });
      const sub = Object.assign(document.createElement("div"), { className: "recent-sub", textContent: l.title || l.url, title: l.url });
      text.append(code, sub);
      const btn = document.createElement("button");
      btn.className = "icon-btn";
      btn.type = "button";
      btn.title = "Copy short link";
      btn.setAttribute("aria-label", `Copy ${shortLabel(base, l.code)}`);
      btn.innerHTML = '<span data-icon="copy"></span>';
      mountIcons(btn);
      btn.addEventListener("click", async () => {
        if (await copyText(`${base}/${l.code}`)) flashDone(btn);
      });
      li.append(text, btn);
      list.append(li);
    }
    $("recent").hidden = links.length === 0;
  } catch {
    $("recent").hidden = true; // recent links are a convenience; never block the popup
  }
}

let bound = false;
function bindOnce() {
  if (bound) return;
  bound = true;
  mountIcons();
  const openManage = (e) => {
    e?.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("manage.html") });
    window.close();
  };
  $("manage").addEventListener("click", openManage);
  $("see-all").addEventListener("click", openManage);
  $("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  // The Google window would close this popup (popups close when they lose focus) and
  // abort the sign-in, so signing in runs in the settings tab instead.
  $("google-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: `${chrome.runtime.getURL("options.html")}#signin` });
    window.close();
  });
  $("setup-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("retry").addEventListener("click", generate);
}

/** (Re)evaluates how we are connected and shows the right screen. Safe to call again. */
async function start() {
  const conn = await connect();
  base = conn.base;
  if (!conn.client) {
    $("setup-text").textContent = conn.authEnabled
      ? `Use your @${conn.domain} Google account.`
      : "Add your API key in settings to start creating links.";
    $("google-btn").hidden = !conn.authEnabled;
    $("setup-btn").textContent = conn.authEnabled ? "Use an API key instead" : "Open settings";
    $("setup-btn").className = conn.authEnabled ? "link-btn" : "btn primary";
    return showOnly("setup");
  }
  client = conn.client;

  tab = await activeTab();
  const check = checkTabUrl(tab.url);
  if (!check.ok) {
    $("blocked-text").textContent = check.reason;
    showOnly("blocked");
    return loadRecent();
  }
  tab.url = check.url;
  await generate();
}

$("alias").addEventListener("input", () => {
  // Same normalisation the Worker applies, so what you see is what is saved.
  $("alias").value = $("alias").value.toLowerCase().replace(/\s+/g, "-");
  syncSave();
  const v = $("alias").value;
  if (v === currentCode || v === "") return say("");
  const problem = aliasProblem(v);
  say(problem ?? "", problem ? "err" : "");
});

async function save() {
  const next = $("alias").value;
  const problem = aliasProblem(next);
  if (problem) return say(problem, "err");
  $("save").disabled = true;
  say("Saving…");
  try {
    const link = await client.rename(currentCode, next);
    currentCode = link.code;
    $("alias").value = link.code;
    paintQr();
    say((await copyText(shortUrl())) ? "Saved and copied." : "Saved.", "ok");
    loadRecent();
  } catch (err) {
    say(describeError(err, base), "err");
  } finally {
    $("save").disabled = false;
    syncSave();
  }
}

$("save").addEventListener("click", save);
$("alias").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$("save").hidden) save();
});
$("copy").addEventListener("click", async () => {
  const ok = await copyText(shortUrl());
  if (ok) flashDone($("copy"));
  say(ok ? "Copied." : "Could not copy. Select the link and copy it manually.", ok ? "ok" : "err");
});
$("qr-png").addEventListener("click", async () => {
  downloadBlob(await qrPngBlob(shortUrl(), 1024), `lfc-tools-${slug(currentCode)}-qr.png`);
  say("QR code saved as PNG.", "ok");
});
$("qr-svg").addEventListener("click", () => {
  downloadBlob(qrSvgBlob(shortUrl()), `lfc-tools-${slug(currentCode)}-qr.svg`);
  say("QR code saved as SVG.", "ok");
});

async function init() {
  bindOnce();
  await start();
}

init().catch((err) => {
  $("failed-text").textContent = describeError(err instanceof ApiError ? err : new Error("x"), base);
  showOnly("failed");
});
