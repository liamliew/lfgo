import { corsHeaders, checkAuth, apiError, htmlPage, json, pinPage, readJson, withHeaders } from "./http";
import type { GuardStatus } from "./guard";
import { PIN_RE, makeLock, verifyPin } from "./pin";
import {
  deleteLink, findByUrl, getLink, listLinks, putLink, type Link,
} from "./store";
import type { Env } from "./types";
import { cleanTitle, generateCode, normalizeCode, validateAlias, validateUrl } from "./validate";

const GENERATE_ATTEMPTS = 5;

function baseUrl(request: Request, env: Env): string {
  return (env.SHORT_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
}

function present(link: Link, base: string) {
  return {
    code: link.code,
    shortUrl: `${base}/${link.code}`,
    url: link.url,
    title: link.title ?? null,
    locked: link.locked,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

async function codeExists(env: Env, code: string): Promise<boolean> {
  return (await env.LINKS.get(code)) !== null;
}

// ---------------------------------------------------------------- redirect

function codeFromPath(path: string): string | null {
  let code: string;
  try {
    code = normalizeCode(decodeURIComponent(path.slice(1)));
  } catch {
    return null;
  }
  return code.includes("/") ? null : code;
}

const notFound = () =>
  htmlPage(404, "Link not found", "Link not found", "This short link does not exist or was removed.");

const redirectTo = (link: Link, status: 302 | 303) =>
  new Response(null, { status, headers: { location: link.url, "cache-control": "no-store" } });

async function handleRedirect(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/") {
    return htmlPage(200, "Short links", "Short links", "Nothing to see here.");
  }
  const code = codeFromPath(path);
  const link = code ? await getLink(env, code).catch(() => null) : null;
  if (!link) return notFound();
  // A locked link never reveals its destination: it shows the PIN page instead.
  if (link.lock) return pinPage(env.PIN_SECRET && env.PIN_GUARD ? { kind: "prompt" } : { kind: "unavailable" });
  return redirectTo(link, 302);
}

async function guardCall(env: Env, salt: string, op: "check" | "fail" | "ok", ip: string): Promise<GuardStatus | null> {
  const ns = env.PIN_GUARD;
  if (!ns) return null;
  try {
    const res = await ns.get(ns.idFromName(salt)).fetch(`https://pin-guard/${op}?ip=${encodeURIComponent(ip)}`, {
      method: op === "check" ? "GET" : "POST",
    });
    return res.ok ? ((await res.json()) as GuardStatus) : null;
  } catch {
    return null;
  }
}

/** POST /<code>: submit a PIN. Wrong guesses are counted by the PinGuard object. */
async function handleUnlock(request: Request, env: Env, path: string): Promise<Response> {
  const code = codeFromPath(path);
  const link = code ? await getLink(env, code).catch(() => null) : null;
  if (!link) return notFound();
  if (!link.lock) return redirectTo(link, 303);

  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return htmlPage(403, "Forbidden", "Forbidden", "This request did not come from the PIN page.");
  }
  if (!env.PIN_SECRET || !env.PIN_GUARD) return pinPage({ kind: "unavailable" });

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const before = await guardCall(env, link.lock.s, "check", ip);
  if (!before) return pinPage({ kind: "unavailable" }); // fail closed
  if (!before.allowed) return pinPage({ kind: "blocked", retryAfter: before.retryAfter });

  const text = await request.text();
  const pin = text.length <= 1024 ? (new URLSearchParams(text).get("pin") ?? "").trim() : "";
  if (await verifyPin(link.lock, pin, env.PIN_SECRET)) {
    await guardCall(env, link.lock.s, "ok", ip);
    return redirectTo(link, 303);
  }
  const after = await guardCall(env, link.lock.s, "fail", ip);
  if (!after) return pinPage({ kind: "unavailable" });
  return after.allowed
    ? pinPage({ kind: "wrong", remaining: after.remaining })
    : pinPage({ kind: "blocked", retryAfter: after.retryAfter });
}

// --------------------------------------------------------------------- api

/** Validates the optional `pin` field. `pin: undefined` in the result means "no PIN". */
async function parsePin(raw: unknown, env: Env): Promise<{ pin?: string } | Response> {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw !== "string" || !PIN_RE.test(raw)) return apiError(400, "pin must be exactly 6 digits", "invalid_pin");
  if (!env.PIN_SECRET || !env.PIN_GUARD) {
    return apiError(503, "PIN locks are not set up on the server yet", "pin_unavailable");
  }
  return { pin: raw };
}

async function handleApi(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;
  const url = new URL(request.url);
  const base = baseUrl(request, env);
  const selfHost = new URL(base).hostname;

  const m = path.match(/^\/api\/links(?:\/([^/]+))?\/?$/);
  if (!m) return apiError(404, "Not found");
  const codeParam = m[1] ? normalizeCode(decodeURIComponent(m[1])) : null;

  // Collection: GET (list / lookup by url), POST (create)
  if (!codeParam) {
    if (method === "GET") {
      const wanted = url.searchParams.get("url");
      if (wanted) {
        const check = validateUrl(wanted, selfHost);
        if (!check.ok) return apiError(400, check.error);
        const hit = await findByUrl(env, check.url);
        return json({ links: hit ? [present(hit, base)] : [], listComplete: true });
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
      const page = await listLinks(env, {
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit,
      });
      return json({
        links: page.links.map((l) => present(l, base)),
        cursor: page.cursor ?? null,
        listComplete: page.listComplete,
      });
    }

    if (method === "POST") {
      const parsed = await readJson(request);
      if (!parsed.ok) return parsed.res;
      const target = validateUrl(parsed.body.url, selfHost);
      if (!target.ok) return apiError(400, target.error);
      const rawTitle = parsed.body.title;
      if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== "string") {
        return apiError(400, "title must be a string");
      }
      const title = typeof rawTitle === "string" ? cleanTitle(rawTitle) : "";
      const pinInput = await parsePin(parsed.body.pin, env);
      if (pinInput instanceof Response) return pinInput;

      let code: string;
      const rawAlias = parsed.body.alias;
      if (rawAlias !== undefined && rawAlias !== null && rawAlias !== "") {
        if (typeof rawAlias !== "string") return apiError(400, "alias must be a string");
        code = normalizeCode(rawAlias);
        const problem = validateAlias(code);
        if (problem) return apiError(400, problem, "invalid_alias");
        if (await codeExists(env, code)) return apiError(409, "That alias is already taken", "alias_taken");
      } else {
        let found: string | null = null;
        for (let i = 0; i < GENERATE_ATTEMPTS && !found; i++) {
          const candidate = generateCode();
          if (validateAlias(candidate) === null && !(await codeExists(env, candidate))) found = candidate;
        }
        if (!found) return apiError(503, "Could not generate a free code, try again");
        code = found;
      }

      const now = new Date().toISOString();
      const rec = {
        url: target.url,
        ...(title ? { title } : {}),
        ...(pinInput.pin ? { lock: await makeLock(pinInput.pin, env.PIN_SECRET as string) } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await putLink(env, code, rec);
      return json(present({ code, ...rec, locked: !!rec.lock }, base), 201);
    }
    return apiError(405, "Method not allowed");
  }

  // Item: GET, PATCH, DELETE
  const code = codeParam;

  if (method === "GET") {
    const link = await getLink(env, code);
    return link ? json(present(link, base)) : apiError(404, "Link not found", "not_found");
  }

  if (method === "PATCH") {
    const parsed = await readJson(request);
    if (!parsed.ok) return parsed.res;
    const { newCode: rawNew, url: rawUrl, title: rawTitle, pin: rawPin } = parsed.body;
    if (rawNew === undefined && rawUrl === undefined && rawTitle === undefined && rawPin === undefined) {
      return apiError(400, "Provide newCode, url, title and/or pin");
    }
    if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== "string") {
      return apiError(400, "title must be a string");
    }

    const current = await getLink(env, code);
    if (!current) return apiError(404, "Link not found", "not_found");

    // pin: omitted keeps the current lock, a 6-digit string sets/changes it,
    // null or "" removes it. The lock does not depend on the code, so a rename keeps it.
    const pinInput = await parsePin(rawPin, env);
    if (pinInput instanceof Response) return pinInput;
    let lock = current.lock;
    if (rawPin !== undefined) lock = pinInput.pin ? await makeLock(pinInput.pin, env.PIN_SECRET as string) : undefined;

    let destination = current.url;
    if (rawUrl !== undefined) {
      const target = validateUrl(rawUrl, selfHost);
      if (!target.ok) return apiError(400, target.error);
      destination = target.url;
    }

    let nextCode = code;
    if (rawNew !== undefined) {
      if (typeof rawNew !== "string") return apiError(400, "newCode must be a string");
      nextCode = normalizeCode(rawNew);
      if (nextCode !== code) {
        const problem = validateAlias(nextCode);
        if (problem) return apiError(400, problem, "invalid_alias");
        if (await codeExists(env, nextCode)) {
          return apiError(409, "That alias is already taken", "alias_taken");
        }
      }
    }

    // title: omitted keeps the current one, "" or null clears it.
    const title = rawTitle === undefined ? current.title : cleanTitle(rawTitle ?? "");
    const rec = {
      url: destination,
      ...(title ? { title } : {}),
      ...(lock ? { lock } : {}),
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    // Write the new key before removing the old one so a failure part-way
    // never loses the link; at worst both codes briefly resolve.
    await putLink(env, nextCode, rec);
    if (nextCode !== code) await deleteLink(env, code);
    return json(present({ code: nextCode, ...rec, locked: !!rec.lock }, base));
  }

  if (method === "DELETE") {
    const existing = await getLink(env, code);
    if (!existing) return apiError(404, "Link not found", "not_found");
    await deleteLink(env, code);
    return json({ deleted: true, code });
  }

  return apiError(405, "Method not allowed");
}

// ------------------------------------------------------------------ router

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;

    if (path === "/api" || path.startsWith("/api/")) {
      const cors = corsHeaders(request, env);
      if (request.method === "OPTIONS") {
        // Preflight carries no credentials; only allow-listed origins get CORS headers.
        return new Response(null, { status: cors["access-control-allow-origin"] ? 204 : 403, headers: cors });
      }
      const denied = await checkAuth(request, env);
      if (denied) return withHeaders(denied, cors);
      try {
        return withHeaders(await handleApi(request, env, path), cors);
      } catch (err) {
        console.error("api error", err);
        return withHeaders(apiError(500, "Internal error"), cors);
      }
    }

    if (request.method === "GET" || request.method === "HEAD") {
      return handleRedirect(request, env, path);
    }
    if (request.method === "POST" && path !== "/") {
      return handleUnlock(request, env, path);
    }
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD, POST" } });
  },
} satisfies ExportedHandler<Env>;

export { PinGuard } from "./guard";
