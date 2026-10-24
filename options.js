import {
  AuthError, connect, getAccessToken, getSession, loadAuthConfig, signInWithGoogle, signOut,
} from "./auth.js";
import {
  DEFAULT_BASE, createClient, describeError, loadSettings, normalizeBase, removeApiKey, saveSettings,
} from "./shared.js";
import { copyText, mountIcons } from "./ui.js";

const $ = (id) => document.getElementById(id);
const baseEl = $("base");
const keyEl = $("key");
let savedKey = "";

function say(text, kind = "") {
  $("msg").textContent = text;
  $("msg").className = `msg ${kind}`.trim();
}
function sayAccount(text, kind = "") {
  $("account-msg").textContent = text;
  $("account-msg").className = `msg ${kind}`.trim();
}

function reflectKey() {
  $("key-hint").textContent = savedKey
    ? "A key is saved. Leave this blank to keep it, or enter a new one to replace it."
    : "Paste the key you set with `wrangler secret put API_KEY`.";
  $("forget").hidden = !savedKey;
}

async function renderAccount() {
  const [cfg, session] = await Promise.all([loadAuthConfig(), getSession()]);
  $("account-off").hidden = cfg.enabled;
  $("account-out").hidden = !cfg.enabled || !!session;
  $("account-in").hidden = !session;
  $("who").textContent = session?.email ?? "";
  $("account-out-text").textContent = `Use your @${cfg.domain} Google account.`;
  // Signed in with Google: the API key is optional, so tuck it away.
  $("advanced").open = !cfg.enabled || !session;
}

async function load() {
  mountIcons();
  const s = await loadSettings();
  baseEl.value = s.base === DEFAULT_BASE ? new URL(s.base).host : s.base;
  savedKey = s.apiKey;
  reflectKey();
  await renderAccount();
  $("origin").textContent = `chrome-extension://${chrome.runtime.id}`;
  $("redirect-url").textContent = chrome.identity.getRedirectURL();
}

// ---------------------------------------------------------------- Google sign-in

let signingIn = false;
async function startSignIn() {
  if (signingIn) return;
  signingIn = true;
  $("google-btn").disabled = true;
  sayAccount("Opening Google…");
  try {
    const session = await signInWithGoogle();
    await renderAccount();
    sayAccount(`Signed in as ${session.email}. You can close this tab and click the LFC Tools icon.`, "ok");
  } catch (err) {
    await renderAccount();
    sayAccount(err instanceof AuthError ? err.message : "Sign-in failed. Try again.", err?.code === "cancelled" ? "" : "err");
  } finally {
    signingIn = false;
    $("google-btn").disabled = false;
  }
}
$("google-btn").addEventListener("click", startSignIn);
$("signout").addEventListener("click", async () => {
  await signOut();
  await renderAccount();
  sayAccount("Signed out.", "ok");
});

// ---------------------------------------------------------------- server settings

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
  const typed = keyEl.value.trim();
  // Test what would actually be used: a typed key first, else the Google session, else the saved key.
  const conn = await connect();
  const useTyped = !!typed;
  if (!useTyped && !conn.client) return say("Sign in with Google or enter an API key first.", "err");
  say("Testing…");
  try {
    const client = useTyped
      ? createClient({ base: base.base, apiKey: typed })
      : createClient({ base: base.base, apiKey: savedKey, getToken: conn.mode === "google" ? () => getAccessToken() : undefined });
    await client.list(1);
    say(useTyped ? "Connected. The domain and key work." : conn.mode === "google" ? `Connected as ${conn.email}.` : "Connected. The domain and key work.", "ok");
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

$("open-manage").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("manage.html") });
});

async function copyInto(sourceId, label) {
  const ok = await copyText($(sourceId).textContent);
  say(ok ? `${label} copied.` : "Could not copy. Select it and copy it manually.", ok ? "ok" : "err");
}
$("copy-origin").addEventListener("click", () => copyInto("origin", "Address"));
$("copy-redirect").addEventListener("click", () => copyInto("redirect-url", "Redirect URL"));

load().then(() => {
  // Opened from the popup's "Sign in with Google": start straight away.
  if (location.hash === "#signin") {
    history.replaceState(null, "", location.pathname);
    getSession().then((s) => { if (!s) startSignIn(); });
  }
});
