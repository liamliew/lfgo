// Google sign-in against the "LF ID" Supabase project, using the PKCE flow:
//   1. open <project>/auth/v1/authorize?provider=google&code_challenge=...&code_challenge_method=s256
//      in chrome.identity.launchWebAuthFlow, with this extension's chromiumapp.org
//      address as redirect_to;
//   2. the flow ends on that address with ?code=...;
//   3. POST <project>/auth/v1/token?grant_type=pkce {auth_code, code_verifier} for the session.
// Refreshing uses POST .../token?grant_type=refresh_token {refresh_token}. Refresh tokens
// are single-use, so refreshes are serialised across the popup and manage page with
// navigator.locks. Sessions live in chrome.storage.local (never storage.sync).
//
// Safari has no chrome.identity (Apple: "initiate an OAuth flow in a new tab"). There the
// same flow runs in an ordinary tab and returns to <short domain>/auth/done, a static page
// served by the Worker; auth-bridge.js (a content script in the Safari build only) reports
// that page's address back to the extension and the tab is closed.

import { ALLOWED_DOMAIN, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";
import { createClient, loadSettings } from "./shared.js";

const SESSION_KEY = "session";
const REFRESH_MARGIN_S = 60;

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

/** Project URL and publishable key: stored overrides (for development), else config.js. */
export async function loadAuthConfig(area = chrome.storage.local) {
  const o = await area.get({ supabaseUrl: "", supabaseKey: "" });
  const url = (o.supabaseUrl || SUPABASE_URL).trim().replace(/\/+$/, "");
  const key = (o.supabaseKey || SUPABASE_PUBLISHABLE_KEY).trim();
  return { url, key, enabled: Boolean(url && key), domain: ALLOWED_DOMAIN };
}

// --------------------------------------------------------- sign-in in a tab (Safari)

export const AUTH_MESSAGE = "lfc-auth-result";
export const AUTH_DONE_PATH = "/auth/done";
const TAB_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/** True where chrome.identity.launchWebAuthFlow exists (Chrome, Edge, Brave; not Safari). */
export const hasIdentityApi = () => typeof chrome !== "undefined" && typeof chrome.identity?.launchWebAuthFlow === "function";

/** Where the tab flow returns to: the Worker's landing page on the configured short domain. */
export const tabRedirectUrl = (base) => `${new URL(base).origin}${AUTH_DONE_PATH}`;

/**
 * Opens `url` in a tab and resolves with the address the flow ended on, which is the first
 * report from that very tab (sender checked) of an address beginning with `doneUrl`.
 * Rejects if the tab is closed first or nothing happens for five minutes.
 */
export function launchInTab(url, doneUrl, env = {}) {
  const tabs = env.tabs ?? chrome.tabs;
  const runtime = env.runtime ?? chrome.runtime;
  const timeoutMs = env.timeoutMs ?? TAB_SIGN_IN_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let tabId = null;
    let timer = null;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runtime.onMessage.removeListener(onMessage);
      tabs.onRemoved.removeListener(onRemoved);
      if (tabId !== null) Promise.resolve(tabs.remove(tabId)).catch(() => {});
      fn(value);
    };
    const onMessage = (msg, sender) => {
      if (msg?.type !== AUTH_MESSAGE || tabId === null || sender?.tab?.id !== tabId) return;
      if (typeof msg.url !== "string" || !msg.url.startsWith(doneUrl)) return;
      finish(resolve, msg.url);
    };
    const onRemoved = (id) => {
      if (id === tabId) {
        tabId = null; // already gone: nothing to close
        finish(reject, new Error("The sign-in tab was closed."));
      }
    };
    runtime.onMessage.addListener(onMessage);
    tabs.onRemoved.addListener(onRemoved);
    timer = setTimeout(() => finish(reject, new Error("Sign-in timed out and was cancelled.")), timeoutMs);
    Promise.resolve(tabs.create({ url, active: true })).then(
      (tab) => {
        tabId = tab.id;
        if (settled) tabs.remove(tab.id)?.catch?.(() => {});
      },
      (e) => finish(reject, e),
    );
  });
}

// --------------------------------------------------------------------- PKCE

const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** 43 characters of unreserved base64url: a valid RFC 7636 code verifier. */
export function randomVerifier(rng = (a) => crypto.getRandomValues(a)) {
  const bytes = new Uint8Array(32);
  rng(bytes);
  return b64url(bytes);
}

export async function challengeFor(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

// ------------------------------------------------------------------ sessions

export async function getSession(area = chrome.storage.local) {
  const o = await area.get({ [SESSION_KEY]: null });
  const s = o[SESSION_KEY];
  return s && s.access_token && s.refresh_token ? s : null;
}

const saveSession = (area, session) => area.set({ [SESSION_KEY]: session });
const clearSession = (area) => area.remove(SESSION_KEY);

function emailFromToken(token) {
  try {
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    return typeof payload.email === "string" ? payload.email : "";
  } catch {
    return "";
  }
}

function toSession(data, now, previous) {
  const nowS = Math.floor(now / 1000);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: typeof data.expires_at === "number" ? data.expires_at : nowS + (Number(data.expires_in) || 3600),
    email: (data.user?.email || emailFromToken(data.access_token) || previous?.email || "").toLowerCase(),
  };
}

async function authPost(cfg, path, body, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${cfg.url}/auth/v1/${path}`, {
      method: "POST",
      headers: { apikey: cfg.key, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError("network", "Could not reach the sign-in service. Check your connection.");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { res, data };
}

// ------------------------------------------------------------------- sign in

function callbackError(url) {
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const description = url.searchParams.get("error_description") || hash.get("error_description");
  const code = url.searchParams.get("error") || hash.get("error");
  return description || code || "";
}

export async function signInWithGoogle(deps = {}) {
  const area = deps.area ?? chrome.storage.local;
  const cfg = deps.config ?? (await loadAuthConfig(area));
  if (!cfg.enabled) throw new AuthError("not_configured", "Google sign-in is not set up in this version yet.");
  const fetchImpl = deps.fetchImpl ?? ((...a) => fetch(...a));
  const now = deps.now ?? (() => Date.now());
  const native = hasIdentityApi();
  const redirectUrl = deps.redirectUrl ?? (native ? chrome.identity.getRedirectURL() : tabRedirectUrl((await loadSettings(area)).base));
  const launch = deps.launch ?? (native ? (opts) => chrome.identity.launchWebAuthFlow(opts) : (opts) => launchInTab(opts.url, redirectUrl));

  const verifier = randomVerifier(deps.rng);
  const params = new URLSearchParams({
    provider: "google",
    redirect_to: redirectUrl,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "s256",
    hd: cfg.domain, // hint for Google's account picker; the server is what enforces the domain
    prompt: "select_account",
  });

  let finalUrl;
  try {
    finalUrl = await launch({ url: `${cfg.url}/auth/v1/authorize?${params}`, interactive: true });
  } catch (e) {
    throw new AuthError("cancelled", /did not approve|closed|cancel/i.test(String(e?.message)) ? "Sign-in was cancelled." : `Sign-in could not start: ${e?.message ?? e}`);
  }
  if (!finalUrl) throw new AuthError("cancelled", "Sign-in was cancelled.");

  const url = new URL(finalUrl);
  const code = url.searchParams.get("code");
  if (!code) {
    const reason = callbackError(url);
    throw new AuthError("denied", reason ? `Google sign-in failed: ${reason.replace(/\+/g, " ")}` : "Google sign-in did not finish.");
  }

  const { res, data } = await authPost(cfg, "token?grant_type=pkce", { auth_code: code, code_verifier: verifier }, fetchImpl);
  if (!res.ok || !data?.access_token) {
    throw new AuthError("exchange_failed", data?.error_description || data?.msg || "Could not complete sign-in. Try again.");
  }
  const session = toSession(data, now());
  const domain = session.email.split("@")[1];
  if (!session.email || domain !== cfg.domain.toLowerCase()) {
    throw new AuthError("wrong_domain", `Only @${cfg.domain} accounts can sign in.`);
  }
  await saveSession(area, session);
  return session;
}

// --------------------------------------------------------------------- tokens

/**
 * A valid access token, refreshing it when it is about to expire. Returns null when
 * there is no session or the refresh was rejected (the session is then cleared);
 * throws AuthError("network") when the service is unreachable (the session is kept).
 */
export async function getAccessToken(deps = {}) {
  const area = deps.area ?? chrome.storage.local;
  const now = deps.now ?? (() => Date.now());
  const fresh = (s) => s.expires_at - REFRESH_MARGIN_S > now() / 1000;

  let session = await getSession(area);
  if (!session) return null;
  if (fresh(session)) return session.access_token;

  const lock = deps.lock ?? ((name, fn) => navigator.locks.request(name, fn));
  return lock("lfc-auth-refresh", async () => {
    session = await getSession(area); // another window may have refreshed while we waited
    if (!session) return null;
    if (fresh(session)) return session.access_token;
    const cfg = deps.config ?? (await loadAuthConfig(area));
    if (!cfg.enabled) return null;
    const fetchImpl = deps.fetchImpl ?? ((...a) => fetch(...a));
    const { res, data } = await authPost(cfg, "token?grant_type=refresh_token", { refresh_token: session.refresh_token }, fetchImpl);
    if (res.status >= 400 && res.status < 500) {
      await clearSession(area); // refresh token revoked, used up or expired: sign in again
      return null;
    }
    if (!res.ok || !data?.access_token) throw new AuthError("network", "The sign-in service is having trouble. Try again.");
    const next = toSession(data, now(), session);
    await saveSession(area, next);
    return next.access_token;
  });
}

export async function signOut(deps = {}) {
  const area = deps.area ?? chrome.storage.local;
  const session = await getSession(area);
  await clearSession(area);
  if (!session) return;
  try {
    const cfg = deps.config ?? (await loadAuthConfig(area));
    if (cfg.enabled) {
      await (deps.fetchImpl ?? ((...a) => fetch(...a)))(`${cfg.url}/auth/v1/logout`, {
        method: "POST",
        headers: { apikey: cfg.key, authorization: `Bearer ${session.access_token}` },
      });
    }
  } catch {
    /* best effort: the local session is already gone */
  }
}

// ------------------------------------------------------------------- connect

/**
 * What the pages call on load. Prefers the Google session; falls back to the API key.
 * `mode` is "google", "key" or null (nothing set up yet).
 */
export async function connect(area = chrome.storage.local) {
  const [settings, cfg, session] = await Promise.all([loadSettings(area), loadAuthConfig(area), getSession(area)]);
  const mode = session ? "google" : settings.apiKey ? "key" : null;
  const base = { base: settings.base, authEnabled: cfg.enabled, domain: cfg.domain, email: session?.email ?? null, mode };
  if (!mode) return { ...base, client: null };
  const client = createClient({
    base: settings.base,
    apiKey: settings.apiKey,
    getToken: session ? () => getAccessToken({ area }) : undefined,
  });
  return { ...base, client };
}
