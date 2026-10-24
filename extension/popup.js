import {
  ApiError, aliasProblem, checkTabUrl, createClient, describeError, loadSettings,
} from "./shared.js";

const $ = (id) => document.getElementById(id);
const els = {
  loading: $("loading"), setup: $("setup"), blocked: $("blocked"), ready: $("ready"),
  blockedText: $("blocked-text"), error: $("error"), prefix: $("prefix"), alias: $("alias"),
  save: $("save"), copy: $("copy"), status: $("status"), dest: $("dest"),
};

let client;
let base = "";
let currentCode = "";
let destination = "";

function show(section) {
  for (const key of ["loading", "setup", "blocked", "ready"]) els[key].hidden = key !== section;
}

function say(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `msg ${kind}`.trim();
}

function fail(err) {
  els.error.textContent = describeError(err, base);
  els.error.hidden = false;
}

const shortUrl = () => `${base}/${currentCode}`;

async function copyLink() {
  try {
    await navigator.clipboard.writeText(shortUrl());
    return true;
  } catch {
    return false;
  }
}

function syncSaveState() {
  const value = els.alias.value;
  els.save.disabled = value === currentCode || value === "";
}

function render(link, note) {
  currentCode = link.code;
  els.alias.value = link.code;
  els.prefix.textContent = `${new URL(base).host}/`;
  els.dest.textContent = destination;
  els.dest.parentElement.title = destination;
  show("ready");
  syncSaveState();
  say(note, "");
}

async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.url;
}

async function init() {
  $("open-options").addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  $("setup-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());

  const settings = await loadSettings();
  base = settings.base;
  if (!settings.apiKey) return show("setup");

  const tabCheck = checkTabUrl(await activeTabUrl());
  if (!tabCheck.ok) {
    els.blockedText.textContent = tabCheck.reason;
    return show("blocked");
  }
  destination = tabCheck.url;
  client = createClient({ base, apiKey: settings.apiKey });

  try {
    const existing = await client.findByUrl(destination);
    const link = existing ?? (await client.create(destination));
    render(link, existing ? "Existing link reused." : "Link created.");
    if (await copyLink()) say(existing ? "Existing link reused and copied." : "Link created and copied.", "ok");
  } catch (err) {
    show("blocked");
    els.blockedText.textContent = "";
    fail(err);
  }
}

els.alias.addEventListener("input", () => {
  // Same normalisation the Worker applies, so what you see is what is saved.
  els.alias.value = els.alias.value.toLowerCase().replace(/\s+/g, "-");
  syncSaveState();
  const value = els.alias.value;
  if (value === currentCode || value === "") return say("");
  const problem = aliasProblem(value);
  say(problem ?? "", problem ? "err" : "");
});

async function save() {
  const next = els.alias.value;
  const problem = aliasProblem(next);
  if (problem) return say(problem, "err");
  els.save.disabled = true;
  say("Saving…");
  try {
    const link = await client.rename(currentCode, next);
    currentCode = link.code;
    els.alias.value = link.code;
    say((await copyLink()) ? "Saved and copied." : "Saved.", "ok");
  } catch (err) {
    say(describeError(err, base), "err");
  } finally {
    syncSaveState();
  }
}

els.save.addEventListener("click", save);
els.alias.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !els.save.disabled) save();
});
els.copy.addEventListener("click", async () => {
  const ok = await copyLink();
  say(ok ? "Copied." : "Could not copy. Select the link and copy it manually.", ok ? "ok" : "err");
});

init().catch((err) => {
  show("blocked");
  els.blockedText.textContent = "";
  fail(err instanceof ApiError ? err : new Error("Unexpected error"));
});
