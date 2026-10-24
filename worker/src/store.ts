import type { Lock } from "./pin";
import type { Env } from "./types";

// KV layout: key = short code, value = JSON LinkRecord.
// Key metadata mirrors the record (KV caps metadata at 1024 bytes) so a
// list() call can render the whole table without one get() per key. URLs
// too long for the metadata are left out of it and fetched on demand.
//
// KV is eventually consistent and has no atomic operations; see README.

export interface LinkRecord {
  url: string;
  title?: string;
  /** Present when the link is PIN-locked. Never sent to API clients. */
  lock?: Lock;
  createdAt: string;
  updatedAt: string;
}

export interface Link extends LinkRecord {
  code: string;
  /** True when PIN-locked. `lock` itself is only loaded on full reads. */
  locked: boolean;
}

interface LinkMeta {
  c: string; // createdAt
  m: string; // updatedAt
  u?: string; // url, only when it fits
  t?: string; // title, only when it fits
  k?: 1; // PIN-locked
  f?: 1; // metadata is incomplete: read the full value
}

const META_LIMIT_BYTES = 1000; // KV allows 1024 bytes of serialized metadata
const encoder = new TextEncoder();
const size = (v: unknown) => encoder.encode(JSON.stringify(v)).length;

function toMeta(rec: LinkRecord): LinkMeta {
  const meta: LinkMeta = { c: rec.createdAt, m: rec.updatedAt, ...(rec.lock ? { k: 1 as const } : {}) };
  if (size({ ...meta, u: rec.url }) > META_LIMIT_BYTES) return { ...meta, f: 1 };
  meta.u = rec.url;
  if (rec.title) {
    if (size({ ...meta, t: rec.title }) <= META_LIMIT_BYTES) meta.t = rec.title;
    else meta.f = 1;
  }
  return meta;
}

function parseRecord(raw: string | null): LinkRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LinkRecord>;
    if (typeof v.url !== "string") return null;
    const now = new Date(0).toISOString();
    return {
      url: v.url,
      ...(typeof v.title === "string" && v.title ? { title: v.title } : {}),
      ...(v.lock && typeof v.lock.s === "string" && typeof v.lock.h === "string" ? { lock: v.lock } : {}),
      createdAt: v.createdAt ?? now,
      updatedAt: v.updatedAt ?? v.createdAt ?? now,
    };
  } catch {
    return null;
  }
}

export async function getLink(env: Env, code: string): Promise<Link | null> {
  const rec = parseRecord(await env.LINKS.get(code));
  return rec ? { code, ...rec, locked: !!rec.lock } : null;
}

export async function putLink(env: Env, code: string, rec: LinkRecord): Promise<void> {
  await env.LINKS.put(code, JSON.stringify(rec), { metadata: toMeta(rec) });
}

export async function deleteLink(env: Env, code: string): Promise<void> {
  await env.LINKS.delete(code);
}

export interface Page {
  links: Link[];
  cursor?: string;
  listComplete: boolean;
}

export async function listLinks(
  env: Env,
  opts: { cursor?: string; limit?: number } = {},
): Promise<Page> {
  const res = await env.LINKS.list<LinkMeta>({
    limit: opts.limit ?? 100,
    cursor: opts.cursor,
  });
  const links = (
    await Promise.all(
      res.keys.map(async (k): Promise<Link | null> => {
        const m = k.metadata;
        if (m && !m.f && m.u && m.c) {
          return {
            code: k.name,
            url: m.u,
            ...(m.t ? { title: m.t } : {}),
            locked: !!m.k,
            createdAt: m.c,
            updatedAt: m.m ?? m.c,
          };
        }
        return getLink(env, k.name);
      }),
    )
  ).filter((l): l is Link => l !== null);
  return {
    links,
    cursor: res.list_complete ? undefined : res.cursor,
    listComplete: res.list_complete,
  };
}

/** First link pointing at `url`. Scans the namespace: fine for personal scale. */
export async function findByUrl(env: Env, url: string): Promise<Link | null> {
  let cursor: string | undefined;
  do {
    const page = await listLinks(env, { cursor, limit: 500 });
    const hit = page.links.find((l) => l.url === url);
    if (hit) return hit;
    cursor = page.cursor;
  } while (cursor);
  return null;
}
