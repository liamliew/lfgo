import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { GLOBAL_MAX, PER_IP_MAX, PinGuard } from "../src/guard";
import { makeLock, verifyPin } from "../src/pin";
import type { Env } from "../src/types";
import { FakeKV } from "./fake-kv";

const KEY = "test-key";
const SECRET = "pin-secret-for-tests";

/** In-memory Durable Object namespace that runs the real PinGuard class. */
class FakeGuardNamespace {
  objects = new Map<string, PinGuard>();
  idFromName(name: string) {
    return name;
  }
  get(id: string) {
    let g = this.objects.get(id);
    if (!g) {
      const map = new Map<string, unknown>();
      const storage = { get: async (k: string) => map.get(k), put: async (k: string, v: unknown) => void map.set(k, structuredClone(v)) };
      g = new PinGuard({ storage } as unknown as DurableObjectState);
      this.objects.set(id, g);
    }
    const guard = g;
    return { fetch: (url: string, init?: RequestInit) => guard.fetch(new Request(url, init)) };
  }
}

let kv: FakeKV;
let env: Env;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T10:00:00Z"));
  kv = new FakeKV();
  env = {
    LINKS: kv as unknown as KVNamespace,
    API_KEY: KEY,
    SHORT_BASE_URL: "https://go.test",
    PIN_SECRET: SECRET,
    PIN_GUARD: new FakeGuardNamespace() as unknown as DurableObjectNamespace,
  };
});
afterEach(() => vi.useRealTimers());

const api = (method: string, path: string, body?: unknown) =>
  worker.fetch(
    new Request("https://go.test" + path, {
      method,
      headers: { "x-api-key": KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
const visit = (path: string, ip = "1.1.1.1", method = "GET") => worker.fetch(new Request("https://go.test" + path, { method, headers: { "cf-connecting-ip": ip } }), env);
const submit = (path: string, pin: string, ip = "1.1.1.1", headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request("https://go.test" + path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip, ...headers },
      body: new URLSearchParams({ pin }).toString(),
    }),
    env,
  );
const lockedLink = async (alias = "secret", pin = "123456") =>
  (await api("POST", "/api/links", { url: "https://example.com/private", alias, pin })).json() as Promise<any>;

describe("pin hashing", () => {
  it("verifies the right PIN only, with a different salt every time", async () => {
    const a = await makeLock("123456", SECRET);
    const b = await makeLock("123456", SECRET);
    expect(a.s).not.toBe(b.s);
    expect(a.h).not.toBe(b.h);
    expect(await verifyPin(a, "123456", SECRET)).toBe(true);
    expect(await verifyPin(a, "123457", SECRET)).toBe(false);
    expect(await verifyPin(a, "123456", "another-secret")).toBe(false);
    expect(await verifyPin(a, "12345", SECRET)).toBe(false);
    expect(await verifyPin(a, "abcdef", SECRET)).toBe(false);
    expect(await verifyPin({ s: a.s, h: "not-base64!!" }, "123456", SECRET)).toBe(false);
  });
});

describe("creating and listing locked links", () => {
  it("never returns or stores the PIN in the clear", async () => {
    const created = await lockedLink("secret", "482913");
    expect(created.locked).toBe(true);
    expect(JSON.stringify(created)).not.toContain("482913");
    const stored = kv.store.get("secret")!;
    expect(stored.value).not.toContain("482913");
    expect(JSON.stringify(stored.metadata)).not.toContain("482913");
    const rec = JSON.parse(stored.value);
    expect(rec.lock.s).toBeTruthy();
    expect(rec.lock.h).toBeTruthy();
    const got = (await (await api("GET", "/api/links/secret")).json()) as any;
    expect(got.locked).toBe(true);
    expect(JSON.stringify(got)).not.toMatch(/"lock"|"h"|"s"/);
  });
  it("shows locked in the list and lookup-by-url", async () => {
    await lockedLink("secret");
    await api("POST", "/api/links", { url: "https://example.com/open", alias: "open-one" });
    const list = (await (await api("GET", "/api/links")).json()) as any;
    expect(Object.fromEntries(list.links.map((l: any) => [l.code, l.locked]))).toEqual({ secret: true, "open-one": false });
    const hit = (await (await api("GET", "/api/links?url=" + encodeURIComponent("https://example.com/private"))).json()) as any;
    expect(hit.links[0].locked).toBe(true);
  });
  it("rejects malformed PINs", async () => {
    for (const pin of ["12345", "1234567", "abcdef", "12 456", 123456]) {
      const res = await api("POST", "/api/links", { url: "https://example.com/x", pin });
      expect(res.status, String(pin)).toBe(400);
      expect(((await res.json()) as any).code).toBe("invalid_pin");
    }
  });
  it("answers 503 when the server has no PIN_SECRET or PIN_GUARD", async () => {
    env.PIN_SECRET = undefined;
    const res = await api("POST", "/api/links", { url: "https://example.com/x", alias: "nopin", pin: "123456" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).code).toBe("pin_unavailable");
    expect(kv.store.has("nopin")).toBe(false);
    // creating a link without a PIN still works
    expect((await api("POST", "/api/links", { url: "https://example.com/x", alias: "plain" })).status).toBe(201);
  });
});

describe("opening a locked link", () => {
  it("shows a PIN page and never the destination", async () => {
    await lockedLink();
    const res = await visit("/secret");
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("This link is protected");
    expect(html).not.toContain("example.com");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // Regression: with "no-referrer" Chrome posts the form with "Origin: null", which
    // the same-origin check rejects, so a real browser could never unlock a link.
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await visit("/secret", "1.1.1.1", "HEAD")).headers.get("location")).toBeNull();
  });
  it("redirects with 303 after the right PIN", async () => {
    await lockedLink("secret", "123456");
    const res = await submit("/secret", "123456");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://example.com/private");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects a wrong PIN with 401 and counts attempts down", async () => {
    await lockedLink();
    const r1 = await submit("/secret", "000000");
    expect(r1.status).toBe(401);
    expect(r1.headers.get("location")).toBeNull();
    expect(await r1.text()).toContain(`${PER_IP_MAX - 1} attempts left`);
    expect(await (await submit("/secret", "abc")).text()).toContain("Incorrect PIN");
  });
  it("blocks one IP after 5 wrong guesses, even with the right PIN, but not other IPs", async () => {
    await lockedLink("secret", "123456");
    for (let i = 0; i < PER_IP_MAX; i++) await submit("/secret", String(100000 + i));
    const blocked = await submit("/secret", "123456");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.headers.get("location")).toBeNull();
    expect((await submit("/secret", "123456", "2.2.2.2")).status).toBe(303);
    // the block expires after 15 minutes
    vi.setSystemTime(new Date("2026-10-24T10:16:00Z"));
    expect((await submit("/secret", "123456")).status).toBe(303);
  });
  it("locks the link for everyone after 30 wrong guesses across IPs", async () => {
    await lockedLink("secret", "123456");
    for (let i = 0; i < GLOBAL_MAX; i++) await submit("/secret", String(200000 + i), `10.0.0.${i}`);
    const res = await submit("/secret", "123456", "9.9.9.9");
    expect(res.status).toBe(429);
    vi.setSystemTime(new Date("2026-10-24T11:01:00Z"));
    expect((await submit("/secret", "123456", "9.9.9.9")).status).toBe(303);
  });
  it("a correct PIN resets that visitor's counter", async () => {
    await lockedLink("secret", "123456");
    for (let i = 0; i < PER_IP_MAX - 1; i++) await submit("/secret", "000000");
    expect((await submit("/secret", "123456")).status).toBe(303);
    expect(await (await submit("/secret", "000000")).text()).toContain(`${PER_IP_MAX - 1} attempts left`);
  });
  it("fails closed when PIN checking is not configured", async () => {
    await lockedLink();
    env.PIN_GUARD = undefined;
    const get = await visit("/secret");
    expect(get.status).toBe(503);
    expect(get.headers.get("location")).toBeNull();
    const post = await submit("/secret", "123456");
    expect(post.status).toBe(503);
    expect(post.headers.get("location")).toBeNull();
    env.PIN_GUARD = new FakeGuardNamespace() as unknown as DurableObjectNamespace;
    env.PIN_SECRET = undefined;
    expect((await submit("/secret", "123456")).status).toBe(503);
  });
  it("refuses cross-origin form posts", async () => {
    await lockedLink();
    expect((await submit("/secret", "123456", "1.1.1.1", { origin: "https://evil.example" })).status).toBe(403);
    expect((await submit("/secret", "123456", "1.1.1.1", { origin: "https://go.test" })).status).toBe(303);
  });
  it("ignores huge bodies and missing links", async () => {
    await lockedLink();
    const res = await worker.fetch(new Request("https://go.test/secret", { method: "POST", body: "pin=123456&x=" + "a".repeat(2000) }), env);
    expect(res.status).toBe(401);
    expect((await submit("/missing", "123456")).status).toBe(404);
    expect((await worker.fetch(new Request("https://go.test/", { method: "POST" }), env)).status).toBe(405);
  });
  it("unlocked links are unaffected: plain 302", async () => {
    await api("POST", "/api/links", { url: "https://example.com/open", alias: "open-one" });
    const res = await visit("/open-one");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/open");
  });
});

describe("changing, removing and keeping locks", () => {
  it("sets a PIN on an existing link and changes it", async () => {
    await api("POST", "/api/links", { url: "https://example.com/open", alias: "later" });
    expect((await visit("/later")).status).toBe(302);
    expect(((await (await api("PATCH", "/api/links/later", { pin: "111111" })).json()) as any).locked).toBe(true);
    expect((await visit("/later")).status).toBe(200);
    expect((await submit("/later", "111111")).status).toBe(303);
    await api("PATCH", "/api/links/later", { pin: "222222" });
    expect((await submit("/later", "111111", "3.3.3.3")).status).toBe(401);
    expect((await submit("/later", "222222", "4.4.4.4")).status).toBe(303);
  });
  it("removes the lock with null or an empty string", async () => {
    await lockedLink("secret");
    const j = (await (await api("PATCH", "/api/links/secret", { pin: null })).json()) as any;
    expect(j.locked).toBe(false);
    expect((await visit("/secret")).status).toBe(302);
    await api("PATCH", "/api/links/secret", { pin: "123456" });
    expect(((await (await api("PATCH", "/api/links/secret", { pin: "" })).json()) as any).locked).toBe(false);
  });
  it("keeps the lock when renaming, retitling or repointing", async () => {
    await lockedLink("secret", "123456");
    await api("PATCH", "/api/links/secret", { newCode: "renamed", title: "T", url: "https://example.com/new" });
    expect(kv.store.has("secret")).toBe(false);
    expect(((await (await api("GET", "/api/links/renamed")).json()) as any).locked).toBe(true);
    const ok = await submit("/renamed", "123456");
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("https://example.com/new");
  });
  it("a new PIN gets a fresh attempt counter, and a wrong guess never reveals the old one", async () => {
    await lockedLink("secret", "123456");
    for (let i = 0; i < PER_IP_MAX; i++) await submit("/secret", "000000");
    expect((await submit("/secret", "123456")).status).toBe(429);
    await api("PATCH", "/api/links/secret", { pin: "654321" });
    expect((await submit("/secret", "654321")).status).toBe(303);
  });
  it("validates PINs on patch and handles a 503 without side effects", async () => {
    await lockedLink("secret", "123456");
    expect((await api("PATCH", "/api/links/secret", { pin: "12" })).status).toBe(400);
    env.PIN_SECRET = undefined;
    expect((await api("PATCH", "/api/links/secret", { pin: "999999" })).status).toBe(503);
    // removing a lock does not need the secret
    expect(((await (await api("PATCH", "/api/links/secret", { pin: null })).json()) as any).locked).toBe(false);
  });
  it("metadata overflow with a lock still lists as locked", async () => {
    const url = "https://example.com/" + "p".repeat(900);
    await api("POST", "/api/links", { url, alias: "bigone", title: "T".repeat(140), pin: "123456" });
    const list = (await (await api("GET", "/api/links")).json()) as any;
    const hit = list.links.find((l: any) => l.code === "bigone");
    expect(hit.locked).toBe(true);
    expect(hit.url).toBe(url);
  });
});
