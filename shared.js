// Logic shared by the popup and the options page. No DOM access here so it
// can be unit-tested in Node (see test/shared.test.js).

export const DEFAULT_BASE = "https://go.lfcrea.com";

const ALIAS_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Turn "go.example.com", "https://go.example.com/" etc. into an origin. */
export function normalizeBase(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "Enter your short domain, e.g. go.example.com" };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "That is not a valid domain" };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return { ok: false, error: "Use https:// (http is only allowed for localhost)" };
  }
  return { ok: true, base: url.origin };
}

/** The extension can only shorten ordinary web pages. */
export function checkTabUrl(url) {
  if (!url) {
    return { ok: false, reason: "This page can't be shortened (the browser does not share its address)." };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "This page's address can't be read." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Browser and extension pages (like chrome://) can't be shortened." };
  }
  return { ok: true, url };
}

/** Quick client-side feedback; the server remains the authority. */
export function aliasProblem(alias) {
  if (alias.length < 3 || alias.length > 32) return "Use 3-32 characters";
  if (!ALIAS_RE.test(alias)) return "Only a-z, 0-9 and hyphens; no hyphen at the start or end";
  if (alias.includes("--")) return "No double hyphens";
  return null;
}

const PIN_RE = /^\d{6}$/;
export const isValidPin = (pin) => typeof pin === "string" && PIN_RE.test(pin);

/** A random 6-digit PIN, uniformly distributed (rejection sampling, no modulo bias). */
export function randomPin(rng = (a) => crypto.getRandomValues(a)) {
  const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  do rng(buf); while (buf[0] >= limit);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Human-readable text for an error from the API. */
export function describeError(err, base) {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  if (err.code === "network") {
    return `Could not reach ${base}. Check the domain and your connection. If this is a new setup, the extension's address must be listed in the Worker's ALLOWED_ORIGINS (see Options).`;
  }
  if (err.code === "signed_out") return "You are signed out. Sign in again from Settings.";
  if (err.code === "token_expired" || err.code === "invalid_token") return "Your sign-in expired or was rejected. Sign out and sign in again.";
  if (err.code === "wrong_domain") return err.message || "Only @lfcrea.com Google accounts can use this.";
  if (err.code === "wrong_provider") return "Sign in with your Google account.";
  if (err.code === "sign_in_disabled") return "Google sign-in is not turned on at the server yet. Use the API key for now.";
  if (err.code === "auth_unavailable") return "The sign-in service can't be reached right now. Try again in a moment.";
  if (err.status === 401) return "The API key was rejected. Check it in Settings.";
  if (err.code === "alias_taken") return "That alias is already taken.";
  if (err.code === "pin_unavailable") {
    return "PIN locks are not set up on the server yet. Add the PIN_SECRET secret in Cloudflare (see the Worker README).";
  }
  if (err.status === 500 && err.code === "misconfigured") return "The server has no API key configured yet.";
  return err.message || `Request failed (${err.status}).`;
}

export function createClient({ base, apiKey, getToken, fetchImpl = (...a) => fetch(...a) }) {
  // A signed-in session (getToken) wins; otherwise the API key; otherwise we are signed out.
  async function authHeaders() {
    let token = null;
    if (getToken) {
      try {
        token = await getToken();
      } catch {
        throw new ApiError(0, "network", "Network error");
      }
    }
    if (token) return { authorization: `Bearer ${token}` };
    if (apiKey) return { "x-api-key": apiKey };
    throw new ApiError(401, "signed_out", "You are signed out. Sign in again.");
  }

  async function request(method, path, body) {
    const auth = await authHeaders();
    let res;
    try {
      res = await fetchImpl(base + path, {
        method,
        headers: {
          ...auth,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "network", "Network error");
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      throw new ApiError(res.status, data?.code, data?.error || `Request failed (${res.status})`);
    }
    return data;
  }

  return {
    /** The existing link for this exact destination, or null. */
    async findByUrl(url) {
      const data = await request("GET", `/api/links?url=${encodeURIComponent(url)}`);
      return data.links?.[0] ?? null;
    },
    create: (url, alias, title, pin) =>
      request("POST", "/api/links", {
        url,
        ...(alias ? { alias } : {}),
        ...(title ? { title } : {}),
        ...(pin ? { pin } : {}),
      }),
    /** Change any of { newCode, url, title, pin }; title "" clears it, pin null removes the lock. */
    update: (code, patch) => request("PATCH", `/api/links/${encodeURIComponent(code)}`, patch),
    rename: (code, newCode) => request("PATCH", `/api/links/${encodeURIComponent(code)}`, { newCode }),
    remove: (code) => request("DELETE", `/api/links/${encodeURIComponent(code)}`),
    list: (limit = 1) => request("GET", `/api/links?limit=${limit}`),
    /** Every link, following the pagination cursor. */
    async listAll() {
      const all = [];
      let cursor = null;
      do {
        const page = await request("GET", `/api/links?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        all.push(...(page.links ?? []));
        cursor = page.cursor ?? null;
      } while (cursor);
      return all;
    },
  };
}

// Settings live in storage.local on purpose: storage.sync would copy the API
// key to every browser signed in to this Google account.
export async function loadSettings(area = chrome.storage.local) {
  const s = await area.get({ base: DEFAULT_BASE, apiKey: "" });
  return { base: s.base || DEFAULT_BASE, apiKey: s.apiKey || "" };
}

export function saveSettings(settings, area = chrome.storage.local) {
  return area.set(settings);
}

export function removeApiKey(area = chrome.storage.local) {
  return area.remove("apiKey");
}

// ---------------------------------------------------------------------------
// Helpers for showing and managing lists of links.

export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** "go.example.com/abc" for display. */
export const shortLabel = (base, code) => `${hostOf(base)}/${code}`;

export function sortLinks(links, how = "newest") {
  const out = [...links];
  const byDate = (a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
  if (how === "oldest") out.sort(byDate);
  else if (how === "alias") out.sort((a, b) => a.code.localeCompare(b.code));
  else out.sort((a, b) => byDate(b, a));
  return out;
}

/** Case-insensitive match on code, destination, title and creator. */
export function filterLinks(links, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return links;
  return links.filter((l) =>
    [l.code, l.url, l.title, l.createdBy].some((v) => typeof v === "string" && v.toLowerCase().includes(q)),
  );
}

/** mode: "all" | "locked" | "unlocked" */
export function filterByLock(links, mode) {
  if (mode === "locked") return links.filter((l) => l.locked);
  if (mode === "unlocked") return links.filter((l) => !l.locked);
  return links;
}

const RTF = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat("en", { numeric: "auto" }) : null;

/** "3 days ago", "yesterday", "just now". */
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const sec = Math.round((t - now) / 1000);
  if (Math.abs(sec) < 45) return "just now";
  const steps = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of steps) {
    if (Math.abs(sec) >= size) return RTF.format(Math.round(sec / size), unit);
  }
  return RTF.format(sec, "second");
}

const csvCell = (value) => {
  let v = value == null ? "" : String(value);
  // Spreadsheet formula injection: neutralise cells that would be evaluated.
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

export function toCsv(links, base) {
  // "locked" says whether a PIN is set; PINs are never exported (the server only keeps a hash).
  const head = ["code", "short_url", "destination", "title", "locked", "created_at", "updated_at", "created_by"];
  const rows = links.map((l) => [l.code, `${base}/${l.code}`, l.url, l.title, l.locked ? "yes" : "no", l.createdAt, l.updatedAt, l.createdBy]);
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
