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

/** Returns an error Response, or null when the request carries a valid key. */
export async function checkAuth(request: Request, env: Env): Promise<Response | null> {
  if (!env.API_KEY) return apiError(500, "Server is missing the API_KEY secret", "misconfigured");
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const presented = request.headers.get("x-api-key") || bearer || "";
  if (!presented || !(await safeEqual(presented, env.API_KEY))) {
    return apiError(401, "Missing or invalid API key", "unauthorized");
  }
  return null;
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
