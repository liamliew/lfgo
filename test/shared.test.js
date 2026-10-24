import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ApiError, aliasProblem, checkTabUrl, createClient, describeError, filterLinks, hostOf, loadSettings,
  filterByLock, isValidPin, normalizeBase, randomPin, relativeTime, removeApiKey, saveSettings, shortLabel, sortLinks, toCsv,
} from "../shared.js";

describe("normalizeBase", () => {
  it("accepts bare hosts and full URLs", () => {
    assert.deepEqual(normalizeBase("go.example.com"), { ok: true, base: "https://go.example.com" });
    assert.deepEqual(normalizeBase(" https://go.example.com/some/path?x=1 "), { ok: true, base: "https://go.example.com" });
  });
  it("allows http only for localhost", () => {
    assert.equal(normalizeBase("http://127.0.0.1:8799").base, "http://127.0.0.1:8799");
    assert.equal(normalizeBase("http://localhost:8787").ok, true);
    assert.equal(normalizeBase("http://go.example.com").ok, false);
  });
  it("rejects empty and junk", () => {
    assert.equal(normalizeBase("").ok, false);
    assert.equal(normalizeBase("   ").ok, false);
    assert.equal(normalizeBase("ftp://x.com").ok, false);
  });
});

describe("checkTabUrl", () => {
  it("accepts http(s)", () => {
    assert.equal(checkTabUrl("https://example.com/a?b=1#c").ok, true);
    assert.equal(checkTabUrl("http://example.com").ok, true);
  });
  for (const bad of ["chrome://extensions", "chrome-extension://abc/popup.html", "about:blank", "file:///tmp/x.html", "view-source:https://x.com", "", undefined, "not a url"]) {
    it(`rejects ${String(bad)}`, () => {
      const r = checkTabUrl(bad);
      assert.equal(r.ok, false);
      assert.ok(r.reason.length > 10);
    });
  }
});

describe("aliasProblem", () => {
  it("matches the Worker's rules", () => {
    for (const ok of ["abc", "my-link", "a1b2", "x".repeat(32)]) assert.equal(aliasProblem(ok), null, ok);
    for (const bad of ["ab", "x".repeat(33), "-abc", "abc-", "a--b", "A", "a b", "a_b"]) assert.notEqual(aliasProblem(bad), null, bad);
  });
});

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = await handler(url, init);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

describe("createClient", () => {
  it("sends the key and JSON, finds by url, creates, renames", async () => {
    const f = fakeFetch((url, init) => {
      if (init.method === "GET") return { status: 200, body: { links: [{ code: "abc1234" }] } };
      if (init.method === "POST") return { status: 201, body: { code: "xyz1234" } };
      return { status: 200, body: { code: JSON.parse(init.body).newCode } };
    });
    const c = createClient({ base: "https://go.test", apiKey: "k", fetchImpl: f });
    assert.equal((await c.findByUrl("https://a.com/?q=1")).code, "abc1234");
    assert.equal(f.calls[0].url, "https://go.test/api/links?url=https%3A%2F%2Fa.com%2F%3Fq%3D1");
    assert.equal(f.calls[0].init.headers["x-api-key"], "k");
    assert.equal((await c.create("https://a.com")).code, "xyz1234");
    assert.deepEqual(JSON.parse(f.calls[1].init.body), { url: "https://a.com" });
    assert.equal(f.calls[1].init.headers["content-type"], "application/json");
    await c.create("https://a.com", "docs");
    assert.deepEqual(JSON.parse(f.calls[2].init.body), { url: "https://a.com", alias: "docs" });
    assert.equal((await c.rename("xyz1234", "docs")).code, "docs");
    assert.equal(f.calls[3].url, "https://go.test/api/links/xyz1234");
  });
  it("returns null when nothing matches", async () => {
    const c = createClient({ base: "https://go.test", apiKey: "k", fetchImpl: fakeFetch(() => ({ status: 200, body: { links: [] } })) });
    assert.equal(await c.findByUrl("https://a.com"), null);
  });
  it("maps server errors and network failures to ApiError", async () => {
    const taken = createClient({ base: "https://go.test", apiKey: "k", fetchImpl: fakeFetch(() => ({ status: 409, body: { error: "taken", code: "alias_taken" } })) });
    await assert.rejects(taken.rename("a", "b"), (e) => e instanceof ApiError && e.status === 409 && e.code === "alias_taken");
    const down = createClient({ base: "https://go.test", apiKey: "k", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
    await assert.rejects(down.list(), (e) => e instanceof ApiError && e.code === "network");
  });
});

describe("describeError", () => {
  it("gives actionable messages", () => {
    assert.match(describeError(new ApiError(0, "network", ""), "https://go.test"), /ALLOWED_ORIGINS/);
    assert.match(describeError(new ApiError(401, "unauthorized", "x"), "b"), /API key/);
    assert.equal(describeError(new ApiError(409, "alias_taken", "x"), "b"), "That alias is already taken.");
    assert.equal(describeError(new ApiError(400, "invalid_alias", "Alias too short"), "b"), "Alias too short");
  });
});

describe("settings storage", () => {
  const area = () => {
    const data = {};
    return {
      data,
      get: async (defaults) => ({ ...defaults, ...data }),
      set: async (v) => Object.assign(data, v),
      remove: async (k) => delete data[k],
    };
  };
  it("defaults, saves, and removes the key", async () => {
    const a = area();
    assert.deepEqual(await loadSettings(a), { base: "https://go.lfcrea.com", apiKey: "" });
    await saveSettings({ base: "https://go.x.com", apiKey: "secret" }, a);
    assert.deepEqual(await loadSettings(a), { base: "https://go.x.com", apiKey: "secret" });
    await removeApiKey(a);
    assert.equal((await loadSettings(a)).apiKey, "");
  });
});

const L = (code, o = {}) => ({ code, url: `https://example.com/${code}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...o });

describe("client: titles, update, remove, listAll", () => {
  it("sends the title on create and omits it when empty", async () => {
    const f = fakeFetch(() => ({ status: 201, body: { code: "a" } }));
    const c = createClient({ base: "https://go.test", apiKey: "k", fetchImpl: f });
    await c.create("https://a.com", undefined, "Hello");
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { url: "https://a.com", title: "Hello" });
    await c.create("https://a.com");
    assert.deepEqual(JSON.parse(f.calls[1].init.body), { url: "https://a.com" });
  });
  it("update patches, remove deletes, with encoded codes", async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const c = createClient({ base: "https://go.test", apiKey: "k", fetchImpl: f });
    await c.update("my-code", { newCode: "x", title: "" });
    assert.equal(f.calls[0].init.method, "PATCH");
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { newCode: "x", title: "" });
    await c.remove("my-code");
    assert.equal(f.calls[1].init.method, "DELETE");
    assert.equal(f.calls[1].url, "https://go.test/api/links/my-code");
    assert.equal(f.calls[1].init.body, undefined);
  });
  it("listAll follows the cursor", async () => {
    const pages = [{ links: [L("a"), L("b")], cursor: "c1" }, { links: [L("c")], cursor: null }];
    const f = fakeFetch(() => ({ status: 200, body: pages.shift() }));
    const c = createClient({ base: "https://go.test", apiKey: "k", fetchImpl: f });
    const all = await c.listAll();
    assert.deepEqual(all.map((l) => l.code), ["a", "b", "c"]);
    assert.match(f.calls[1].url, /cursor=c1/);
  });
});

describe("list helpers", () => {
  it("sorts newest, oldest and by alias without mutating", () => {
    const a = L("bbb", { createdAt: "2026-01-02T00:00:00.000Z" });
    const b = L("aaa", { createdAt: "2026-01-03T00:00:00.000Z" });
    const c = L("ccc", { createdAt: "2026-01-01T00:00:00.000Z" });
    const input = [a, b, c];
    assert.deepEqual(sortLinks(input, "newest").map((l) => l.code), ["aaa", "bbb", "ccc"]);
    assert.deepEqual(sortLinks(input, "oldest").map((l) => l.code), ["ccc", "bbb", "aaa"]);
    assert.deepEqual(sortLinks(input, "alias").map((l) => l.code), ["aaa", "bbb", "ccc"]);
    assert.deepEqual(input.map((l) => l.code), ["bbb", "aaa", "ccc"]);
  });
  it("filters on code, url, title and creator, case-insensitively", () => {
    const links = [L("docs", { title: "Team Handbook" }), L("sale", { createdBy: "Sam@lfcrea.com" }), L("zzz")];
    assert.deepEqual(filterLinks(links, "HAND").map((l) => l.code), ["docs"]);
    assert.deepEqual(filterLinks(links, "sam@").map((l) => l.code), ["sale"]);
    assert.deepEqual(filterLinks(links, "example.com/zzz").map((l) => l.code), ["zzz"]);
    assert.equal(filterLinks(links, "  ").length, 3);
    assert.equal(filterLinks(links, "nomatch").length, 0);
  });
  it("formats relative times", () => {
    const now = Date.parse("2026-06-15T12:00:00Z");
    assert.equal(relativeTime("2026-06-15T11:59:50Z", now), "just now");
    assert.equal(relativeTime("2026-06-15T11:00:00Z", now), "1 hour ago");
    assert.equal(relativeTime("2026-06-14T12:00:00Z", now), "yesterday");
    assert.equal(relativeTime("2026-06-08T12:00:00Z", now), "last week");
    assert.equal(relativeTime("garbage", now), "");
  });
  it("labels short links", () => {
    assert.equal(shortLabel("https://go.lfcrea.com", "abc"), "go.lfcrea.com/abc");
    assert.equal(hostOf("not a url"), "not a url");
  });
});

describe("toCsv", () => {
  it("writes a header, quotes awkward cells and neutralises formulas", () => {
    const csv = toCsv([
      L("a", { title: 'He said "hi", ok' }),
      L("b", { title: "=HYPERLINK(\"http://evil\")" }),
      L("c", { title: "-2+3" }),
    ], "https://go.test");
    const lines = csv.split("\r\n");
    assert.equal(lines[0], "code,short_url,destination,title,locked,created_at,updated_at,created_by");
    assert.match(lines[1], /^a,https:\/\/go\.test\/a,https:\/\/example\.com\/a,"He said ""hi"", ok",/);
    assert.match(lines[2], /,"'=HYPERLINK\(""http:\/\/evil""\)",/);
    assert.match(lines[3], /,'-2\+3,/);
    assert.equal(lines.at(-1), "");
  });
});

describe("PIN helpers", () => {
  it("validates exactly six digits", () => {
    for (const ok of ["000000", "123456", "999999"]) assert.equal(isValidPin(ok), true, ok);
    for (const bad of ["12345", "1234567", "12345a", " 12345", "", null, undefined, 123456]) assert.equal(isValidPin(bad), false, String(bad));
  });
  it("randomPin makes zero-padded six-digit strings", () => {
    for (let i = 0; i < 300; i++) assert.match(randomPin(), /^\d{6}$/);
    assert.equal(randomPin((a) => { a[0] = 42; }), "000042");
    assert.equal(randomPin((a) => { a[0] = 999_999; }), "999999");
  });
  it("randomPin rejects values that would bias the result", () => {
    const limit = Math.floor(0x100000000 / 1_000_000) * 1_000_000;
    const queue = [0xffffffff, limit, 7];
    assert.equal(randomPin((a) => { a[0] = queue.shift(); }), "000007");
    assert.equal(queue.length, 0, "both out-of-range draws were discarded");
  });
  it("randomPin is roughly uniform across the digits", () => {
    const counts = Array(10).fill(0);
    for (let i = 0; i < 3000; i++) for (const d of randomPin()) counts[+d]++;
    for (const c of counts) assert.ok(c > 1500 && c < 2100, `digit count ${c} out of range`);
  });
});

describe("client: pin payloads", () => {
  it("sends the pin on create, sets/changes it and removes it with null", async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const c = createClient({ base: "https://go.test", apiKey: "k", fetchImpl: f });
    await c.create("https://a.com", "docs", "T", "123456");
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { url: "https://a.com", alias: "docs", title: "T", pin: "123456" });
    await c.create("https://a.com");
    assert.equal("pin" in JSON.parse(f.calls[1].init.body), false);
    await c.update("docs", { pin: "654321" });
    assert.deepEqual(JSON.parse(f.calls[2].init.body), { pin: "654321" });
    await c.update("docs", { pin: null });
    assert.deepEqual(JSON.parse(f.calls[3].init.body), { pin: null });
  });
  it("explains a server without PIN support", () => {
    assert.match(describeError(new ApiError(503, "pin_unavailable", "x"), "b"), /PIN_SECRET/);
    assert.equal(describeError(new ApiError(400, "invalid_pin", "pin must be exactly 6 digits"), "b"), "pin must be exactly 6 digits");
  });
});

describe("lock filter and CSV", () => {
  const links = [L("a", { locked: true }), L("b", { locked: false }), L("c")];
  it("filters locked / unlocked / all", () => {
    assert.deepEqual(filterByLock(links, "locked").map((l) => l.code), ["a"]);
    assert.deepEqual(filterByLock(links, "unlocked").map((l) => l.code), ["b", "c"]);
    assert.equal(filterByLock(links, "all").length, 3);
  });
  it("exports yes/no for locked and never a PIN", () => {
    const rows = toCsv(links, "https://go.test").split("\r\n");
    assert.match(rows[1], /^a,[^,]+,[^,]+,,yes,/);
    assert.match(rows[2], /^b,[^,]+,[^,]+,,no,/);
    assert.match(rows[3], /^c,[^,]+,[^,]+,,no,/);
    assert.ok(!rows[0].split(",").includes("pin"), "there is no PIN column");
  });
});
