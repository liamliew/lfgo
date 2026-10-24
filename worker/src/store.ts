import type { Env } from "./types";

// KV layout: key = short code, value = JSON LinkRecord.
// Key metadata mirrors the record (KV caps metadata at 1024 bytes) so a
// list() call can render the whole table without one get() per key. URLs
// too long for the metadata are left out of it and fetched on demand.
//
// KV is eventually consistent and has no atomic operations; see README.

export interface LinkRecord {
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface Link extends LinkRecord {
  code: string;
}

interface LinkMeta {
  c: string; // createdAt
  m: string; // updatedAt
  u?: string; // url, only when it fits
}

const META_URL_MAX_BYTES = 700;
const encoder = new TextEncoder();

function toMeta(rec: LinkRecord): LinkMeta {
  const meta: LinkMeta = { c: rec.createdAt, m: rec.updatedAt };
  if (encoder.encode(rec.url).length <= META_URL_MAX_BYTES) meta.u = rec.url;
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
      createdAt: v.createdAt ?? now,
      updatedAt: v.updatedAt ?? v.createdAt ?? now,
    };
  } catch {
    return null;
  }
}

export async function getLink(env: Env, code: string): Promise<Link | null> {
  const rec = parseRecord(await env.LINKS.get(code));
  return rec ? { code, ...rec } : null;
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
        if (m?.u && m.c) {
          return { code: k.name, url: m.u, createdAt: m.c, updatedAt: m.m ?? m.c };
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
