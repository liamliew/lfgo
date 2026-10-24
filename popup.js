import {
  ApiError, aliasProblem, checkTabUrl, createClient, describeError, hostOf, loadSettings, shortLabel, sortLinks,
} from "./shared.js";
import { drawQr, qrPngBlob, qrSvgBlob } from "./qr.js";
import { copyText, downloadBlob, flashDone, mountIcons, slug } from "./ui.js";

const $ = (id) => document.getElementById(id);
const sections = ["setup", "blocked", "failed", "ready"];

let client;
let base = "";
let currentCode = "";
let tab = { url: "", title: "" };

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
    $("alias").value = link.code;
    setLoading(false);
    paintQr();
    syncSave();
    const copied = await copyText(shortUrl());
    say(`${existing ? "Existing link reused" : "Link created"}${copied ? " and copied" : ""}.`, copied ? "ok" : "");
    loadRecent();
  } catch (err) {
    $("failed-text").textContent = describeError(err, base);
    showOnly("failed");
  }
}

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

async function init() {
  mountIcons();
  const openManage = (e) => {
    e?.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("manage.html") });
    window.close();
  };
  $("manage").addEventListener("click", openManage);
  $("see-all").addEventListener("click", openManage);
  $("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("setup-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("retry").addEventListener("click", generate);

  const settings = await loadSettings();
  base = settings.base;
  if (!settings.apiKey) return showOnly("setup");
  client = createClient({ base, apiKey: settings.apiKey });

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
  downloadBlob(await qrPngBlob(shortUrl(), 1024), `lf-go-${slug(currentCode)}-qr.png`);
  say("QR code saved as PNG.", "ok");
});
$("qr-svg").addEventListener("click", () => {
  downloadBlob(qrSvgBlob(shortUrl()), `lf-go-${slug(currentCode)}-qr.svg`);
  say("QR code saved as SVG.", "ok");
});

init().catch((err) => {
  $("failed-text").textContent = describeError(err instanceof ApiError ? err : new Error("x"), base);
  showOnly("failed");
});
