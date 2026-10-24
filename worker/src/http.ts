import { authEnabled, looksLikeJwt, verifyAccessToken, type UserIdentity } from "./auth";
import type { Env } from "./types";

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function apiError(status: number, error: string, code?: string): Response {
  return json(code ? { error, code } : { error }, status);
}

/** Constant-time comparison of two secrets via SHA-256 digests. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export type Caller = { kind: "key" } | UserIdentity;

/**
 * Who is calling /api/*? Either the shared API key (X-API-Key, or Authorization: Bearer
 * with a non-JWT value) or a signed-in @lfcrea.com Google user (Authorization: Bearer
 * with a Supabase access token). Returns an error Response when neither checks out.
 */
export async function authenticate(request: Request, env: Env): Promise<Caller | Response> {
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const headerKey = request.headers.get("x-api-key")?.trim();

  if (!headerKey && bearer && looksLikeJwt(bearer)) {
    const result = await verifyAccessToken(bearer, env);
    if (result.ok) return result.identity;
    return apiError(result.status, result.message, result.code);
  }

  const presented = headerKey || bearer || "";
  if (!env.API_KEY) {
    // No API key configured: that is only fine if Google sign-in is the way in.
    return authEnabled(env)
      ? apiError(401, "Sign in with your Google account", "unauthorized")
      : apiError(500, "Server is missing the API_KEY secret", "misconfigured");
  }
  if (!presented || !(await safeEqual(presented, env.API_KEY))) {
    return apiError(401, "Missing or invalid API key", "unauthorized");
  }
  return { kind: "key" };
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** CORS headers for an allow-listed Origin; empty for everyone else. */
export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  const base: Record<string, string> = { vary: "Origin" };
  if (origin && allowedOrigins(env).includes(origin)) {
    return {
      ...base,
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type, x-api-key, authorization",
      "access-control-max-age": "600",
    };
  }
  return base;
}

export function withHeaders(res: Response, extra: Record<string, string>): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  return out;
}

const BODY_MAX = 8 * 1024;

export async function readJson(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  const text = await request.text();
  if (text.length > BODY_MAX) return { ok: false, res: apiError(413, "Request body too large") };
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return { ok: true, body: v as Record<string, unknown> };
    }
  } catch {
    /* fall through */
  }
  return { ok: false, res: apiError(400, "Body must be a JSON object") };
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#222}main{text-align:center;padding:24px}h1{font-size:1.4rem;margin:0 0 8px}p{margin:0;color:#666}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}}</style></head><body><main>${body}</main></body></html>`;

export function htmlPage(status: number, title: string, heading: string, text: string): Response {
  return new Response(PAGE(title, `<h1>${heading}</h1><p>${text}</p>`), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export type PinPageState =
  | { kind: "prompt" }
  | { kind: "wrong"; remaining: number }
  | { kind: "blocked"; retryAfter: number }
  | { kind: "unavailable" };

const waitText = (seconds: number): string => {
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`;
};

/** The page shown for a PIN-locked link. Never contains the destination. */
export function pinPage(state: PinPageState): Response {
  const status = { prompt: 200, wrong: 401, blocked: 429, unavailable: 503 }[state.kind];
  let note = "";
  let noteClass = "";
  if (state.kind === "wrong") {
    note = `Incorrect PIN. ${state.remaining} ${state.remaining === 1 ? "attempt" : "attempts"} left.`;
    noteClass = "err";
  } else if (state.kind === "blocked") {
    note = `Too many incorrect attempts. Try again in ${waitText(state.retryAfter)}.`;
    noteClass = "err";
  } else if (state.kind === "unavailable") {
    note = "This link is locked, but PIN checking is not set up on the server, so it cannot be opened.";
    noteClass = "err";
  }
  const form =
    state.kind === "unavailable" || state.kind === "blocked"
      ? ""
      : `<form method="post" autocomplete="off"><label for="pin">Enter the 6-digit PIN</label>` +
        `<input id="pin" name="pin" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" ` +
        `autocomplete="off" required autofocus placeholder="••••••" aria-describedby="note">` +
        `<button type="submit">Continue</button></form>`;
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>Protected link</title><style>` +
    `:root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--fg:#101828;--muted:#667085;--line:#e3e6eb;--accent:#4f46e5;--err:#d92d20}` +
    `@media(prefers-color-scheme:dark){:root{--bg:#0f1012;--card:#17181c;--fg:#f2f4f7;--muted:#98a2b3;--line:#2a2d35;--accent:#8b85ff;--err:#ff7a70}}` +
    `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}` +
    `main{width:min(92vw,360px);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 24px;text-align:center}` +
    `svg{width:32px;height:32px;color:var(--accent)}h1{font-size:18px;margin:10px 0 4px}p{margin:0;color:var(--muted)}` +
    `form{display:grid;gap:12px;margin-top:18px;text-align:left}label{font-weight:600;font-size:13px}` +
    `input{width:100%;font:600 24px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.4em;text-align:center;padding:12px 8px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg)}` +
    `input:focus{outline:2px solid var(--accent);outline-offset:1px}button{font:600 15px system-ui;padding:11px;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}` +
    `.err{color:var(--err);margin-top:14px;font-size:14px}</style></head><body><main>` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>` +
    `<h1>This link is protected</h1><p>You need a PIN to continue.</p>${form}` +
    `<p id="note" class="${noteClass}" role="${noteClass ? "alert" : "status"}">${note}</p></main></body></html>`;
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
    // same-origin, not no-referrer: with no-referrer Chrome sends "Origin: null" on the
    // form POST, which the same-origin check in handleUnlock would reject. Either way
    // no Referer reaches the destination after the redirect.
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    // No form-action here on purpose: after a correct PIN the browser is
    // redirected to the destination, and browsers check redirects against it.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  };
  if (state.kind === "blocked") headers["retry-after"] = String(state.retryAfter);
  return new Response(html, { status, headers });
}
