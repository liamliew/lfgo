import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ApiError, aliasProblem, checkTabUrl, createClient, describeError, loadSettings, normalizeBase,
  removeApiKey, saveSettings,
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
