import { corsHeaders, checkAuth, apiError, htmlPage, json, readJson, withHeaders } from "./http";
import {
  deleteLink, findByUrl, getLink, listLinks, putLink, type Link,
} from "./store";
import type { Env } from "./types";
import { generateCode, normalizeCode, validateAlias, validateUrl } from "./validate";

const GENERATE_ATTEMPTS = 5;

function baseUrl(request: Request, env: Env): string {
  return (env.SHORT_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
}

function present(link: Link, base: string) {
  return {
    code: link.code,
    shortUrl: `${base}/${link.code}`,
    url: link.url,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

async function codeExists(env: Env, code: string): Promise<boolean> {
  return (await env.LINKS.get(code)) !== null;
}

// ---------------------------------------------------------------- redirect

async function handleRedirect(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/") {
    return htmlPage(200, "Short links", "Short links", "Nothing to see here.");
  }
  const code = normalizeCode(decodeURIComponent(path.slice(1)));
  const link = code.includes("/") ? null : await getLink(env, code).catch(() => null);
  if (!link) {
    return htmlPage(404, "Link not found", "Link not found", "This short link does not exist or was removed.");
  }
  return new Response(null, {
    status: 302,
    headers: { location: link.url, "cache-control": "no-store" },
  });
}

// --------------------------------------------------------------------- api

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
      const rec = { url: target.url, createdAt: now, updatedAt: now };
      await putLink(env, code, rec);
      return json(present({ code, ...rec }, base), 201);
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
    const { newCode: rawNew, url: rawUrl } = parsed.body;
    if (rawNew === undefined && rawUrl === undefined) {
      return apiError(400, "Provide newCode and/or url");
    }

    const current = await getLink(env, code);
    if (!current) return apiError(404, "Link not found", "not_found");

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

    const rec = {
      url: destination,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    // Write the new key before removing the old one so a failure part-way
    // never loses the link; at worst both codes briefly resolve.
    await putLink(env, nextCode, rec);
    if (nextCode !== code) await deleteLink(env, code);
    return json(present({ code: nextCode, ...rec }, base));
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
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  },
} satisfies ExportedHandler<Env>;
