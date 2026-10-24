import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { FakeKV } from "./fake-kv";

const KEY = "test-key";
const EXT = "chrome-extension://abcdefghijklmnop";
let kv: FakeKV;
let env: Env;

beforeEach(() => {
  kv = new FakeKV();
  env = {
    LINKS: kv as unknown as KVNamespace,
    API_KEY: KEY,
    SHORT_BASE_URL: "https://go.test",
    ALLOWED_ORIGINS: EXT,
  };
});

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "x-api-key": KEY, ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  return worker.fetch(
    new Request("https://go.test" + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
}

describe("auth", () => {
  it("rejects missing and wrong keys, accepts bearer", async () => {
    expect((await call("GET", "/api/links", undefined, { "x-api-key": "" })).status).toBe(401);
    expect((await call("GET", "/api/links", undefined, { "x-api-key": "nope" })).status).toBe(401);
    const ok = await call("GET", "/api/links", undefined, { "x-api-key": "", authorization: `Bearer ${KEY}` });
    expect(ok.status).toBe(200);
  });
  it("fails closed when the secret is not configured", async () => {
    env.API_KEY = undefined;
    expect((await call("GET", "/api/links")).status).toBe(500);
  });
  it("leaves the redirect route public", async () => {
    const res = await worker.fetch(new Request("https://go.test/nothing"), env);
    expect(res.status).toBe(404);
  });
});

describe("create", () => {
  it("generates a code when alias is omitted", async () => {
    const res = await call("POST", "/api/links", { url: "https://example.com/a" });
    expect(res.status).toBe(201);
    const j = (await res.json()) as any;
    expect(j.code).toMatch(/^[a-z0-9]{7}$/);
    expect(j.shortUrl).toBe(`https://go.test/${j.code}`);
    expect(j.url).toBe("https://example.com/a");
    expect(j.createdAt).toBeTruthy();
  });
  it("uses a valid alias and normalises its case", async () => {
    const res = await call("POST", "/api/links", { url: "https://example.com", alias: "My-Link" });
    expect(((await res.json()) as any).code).toBe("my-link");
  });
  it("rejects duplicate, reserved and malformed aliases", async () => {
    await call("POST", "/api/links", { url: "https://example.com", alias: "taken" });
    const dup = await call("POST", "/api/links", { url: "https://other.com", alias: "taken" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as any).code).toBe("alias_taken");
    expect((await call("POST", "/api/links", { url: "https://x.com", alias: "api" })).status).toBe(400);
    expect((await call("POST", "/api/links", { url: "https://x.com", alias: "a b" })).status).toBe(400);
  });
  it("rejects bad urls and bad bodies", async () => {
    expect((await call("POST", "/api/links", { url: "javascript:1" })).status).toBe(400);
    expect((await call("POST", "/api/links", { url: "https://go.test/x" })).status).toBe(400);
    const res = await worker.fetch(
      new Request("https://go.test/api/links", { method: "POST", headers: { "x-api-key": KEY }, body: "{" }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("redirect", () => {
  it("302s to the destination and is case-insensitive", async () => {
    await call("POST", "/api/links", { url: "https://example.com/x?y=1", alias: "dest" });
    const res = await worker.fetch(new Request("https://go.test/DEST"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/x?y=1");
    const head = await worker.fetch(new Request("https://go.test/dest", { method: "HEAD" }), env);
    expect(head.status).toBe(302);
  });
  it("shows a friendly 404", async () => {
    const res = await worker.fetch(new Request("https://go.test/missing"), env);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/html/);
    expect(await res.text()).toMatch(/not found/i);
  });
});

describe("list and lookup", () => {
  it("lists links, including ones with urls too long for KV metadata", async () => {
    const long = "https://example.com/" + "p".repeat(1500);
    await call("POST", "/api/links", { url: "https://short.example", alias: "short" });
    await call("POST", "/api/links", { url: long, alias: "longone" });
    const j = (await (await call("GET", "/api/links")).json()) as any;
    expect(j.links.map((l: any) => l.code).sort()).toEqual(["longone", "short"]);
    expect(j.links.find((l: any) => l.code === "longone").url).toBe(long);
  });
  it("paginates", async () => {
    for (const a of ["aaa", "bbb", "ccc"]) await call("POST", "/api/links", { url: "https://e.com/" + a, alias: a });
    const p1 = (await (await call("GET", "/api/links?limit=2")).json()) as any;
    expect(p1.links).toHaveLength(2);
    expect(p1.listComplete).toBe(false);
    const p2 = (await (await call("GET", `/api/links?limit=2&cursor=${p1.cursor}`)).json()) as any;
    expect(p2.links).toHaveLength(1);
    expect(p2.listComplete).toBe(true);
  });
  it("finds an existing link by destination url", async () => {
    await call("POST", "/api/links", { url: "https://example.com/page", alias: "page" });
    const hit = (await (await call("GET", "/api/links?url=" + encodeURIComponent("https://example.com/page"))).json()) as any;
    expect(hit.links[0].code).toBe("page");
    const miss = (await (await call("GET", "/api/links?url=" + encodeURIComponent("https://example.com/none"))).json()) as any;
    expect(miss.links).toEqual([]);
  });
});

describe("patch", () => {
  it("renames: new code works, old code is gone, createdAt is kept", async () => {
    const created = (await (await call("POST", "/api/links", { url: "https://e.com", alias: "old-name" })).json()) as any;
    const res = await call("PATCH", "/api/links/old-name", { newCode: "new-name" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.code).toBe("new-name");
    expect(j.createdAt).toBe(created.createdAt);
    expect((await worker.fetch(new Request("https://go.test/old-name"), env)).status).toBe(404);
    expect((await worker.fetch(new Request("https://go.test/new-name"), env)).status).toBe(302);
    expect(kv.store.has("old-name")).toBe(false);
  });
  it("refuses to rename onto a taken code and leaves both intact", async () => {
    await call("POST", "/api/links", { url: "https://a.com", alias: "first" });
    await call("POST", "/api/links", { url: "https://b.com", alias: "second" });
    const res = await call("PATCH", "/api/links/first", { newCode: "second" });
    expect(res.status).toBe(409);
    expect(kv.store.has("first")).toBe(true);
    expect(JSON.parse(kv.store.get("second")!.value).url).toBe("https://b.com/");
  });
  it("changes the destination in place", async () => {
    await call("POST", "/api/links", { url: "https://a.com", alias: "dest" });
    const res = await call("PATCH", "/api/links/dest", { url: "https://b.com/new" });
    expect(((await res.json()) as any).url).toBe("https://b.com/new");
    expect((await worker.fetch(new Request("https://go.test/dest"), env)).headers.get("location")).toBe("https://b.com/new");
  });
  it("validates input and handles missing links", async () => {
    await call("POST", "/api/links", { url: "https://a.com", alias: "dest" });
    expect((await call("PATCH", "/api/links/dest", {})).status).toBe(400);
    expect((await call("PATCH", "/api/links/dest", { newCode: "admin" })).status).toBe(400);
    expect((await call("PATCH", "/api/links/dest", { url: "nope" })).status).toBe(400);
    expect((await call("PATCH", "/api/links/ghost", { newCode: "whatever" })).status).toBe(404);
  });
});

describe("delete", () => {
  it("deletes and then 404s", async () => {
    await call("POST", "/api/links", { url: "https://a.com", alias: "gone" });
    expect((await call("DELETE", "/api/links/gone")).status).toBe(200);
    expect((await worker.fetch(new Request("https://go.test/gone"), env)).status).toBe(404);
    expect((await call("DELETE", "/api/links/gone")).status).toBe(404);
  });
});

describe("cors", () => {
  it("answers preflight only for allow-listed origins", async () => {
    const ok = await worker.fetch(
      new Request("https://go.test/api/links", { method: "OPTIONS", headers: { origin: EXT } }),
      env,
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(EXT);
    expect(ok.headers.get("access-control-allow-headers")).toMatch(/x-api-key/);
    const bad = await worker.fetch(
      new Request("https://go.test/api/links", { method: "OPTIONS", headers: { origin: "https://evil.example" } }),
      env,
    );
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("adds CORS headers to API responses (incl. 401) for allowed origins only", async () => {
    const res = await call("GET", "/api/links", undefined, { origin: EXT });
    expect(res.headers.get("access-control-allow-origin")).toBe(EXT);
    const unauth = await call("GET", "/api/links", undefined, { origin: EXT, "x-api-key": "bad" });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("access-control-allow-origin")).toBe(EXT);
    const other = await call("GET", "/api/links", undefined, { origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("does not add CORS to the public redirect", async () => {
    await call("POST", "/api/links", { url: "https://a.com", alias: "pub" });
    const res = await worker.fetch(new Request("https://go.test/pub", { headers: { origin: EXT } }), env);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("titles", () => {
  it("stores a cleaned title and returns it from create, get and list", async () => {
    const res = await call("POST", "/api/links", {
      url: "https://example.com/a",
      alias: "titled",
      title: "  My   page \n title  ",
    });
    expect(((await res.json()) as any).title).toBe("My page title");
    expect(((await (await call("GET", "/api/links/titled")).json()) as any).title).toBe("My page title");
    const list = (await (await call("GET", "/api/links")).json()) as any;
    expect(list.links[0].title).toBe("My page title");
  });
  it("returns null when there is no title and rejects non-strings", async () => {
    const res = await call("POST", "/api/links", { url: "https://example.com/b", alias: "plain" });
    expect(((await res.json()) as any).title).toBeNull();
    expect((await call("POST", "/api/links", { url: "https://example.com/c", title: 5 })).status).toBe(400);
  });
  it("truncates very long titles to 140 characters", async () => {
    const res = await call("POST", "/api/links", { url: "https://example.com/d", alias: "longtitle", title: "x".repeat(500) });
    expect(((await res.json()) as any).title).toHaveLength(140);
  });
  it("survives metadata overflow: long url plus title still lists in full", async () => {
    const url = "https://example.com/" + "p".repeat(850);
    const title = "T".repeat(140);
    const res = await call("POST", "/api/links", { url, alias: "bigmeta", title });
    expect(res.status).toBe(201);
    const list = (await (await call("GET", "/api/links")).json()) as any;
    const hit = list.links.find((l: any) => l.code === "bigmeta");
    expect(hit.url).toBe(url);
    expect(hit.title).toBe(title);
  });
  it("patch sets, keeps (on rename) and clears the title", async () => {
    await call("POST", "/api/links", { url: "https://example.com/e", alias: "edit-me" });
    let j = (await (await call("PATCH", "/api/links/edit-me", { title: "Hello" })).json()) as any;
    expect(j.title).toBe("Hello");
    j = (await (await call("PATCH", "/api/links/edit-me", { newCode: "edited" })).json()) as any;
    expect(j.code).toBe("edited");
    expect(j.title).toBe("Hello");
    j = (await (await call("PATCH", "/api/links/edited", { title: "" })).json()) as any;
    expect(j.title).toBeNull();
    expect((await call("PATCH", "/api/links/edited", { title: 1 })).status).toBe(400);
    expect((await call("PATCH", "/api/links/edited", {})).status).toBe(400);
  });
});
