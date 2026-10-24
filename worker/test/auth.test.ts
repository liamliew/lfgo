import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetAuthCache, verifyAccessToken } from "../src/auth";
import type { Env } from "../src/types";
import { FakeKV } from "./fake-kv";

const SUPABASE = "https://lfid.supabase.co";
const ISS = `${SUPABASE}/auth/v1`;
const JWKS_URL = `${ISS}/.well-known/jwks.json`;
const NOW = Date.parse("2026-10-24T10:00:00Z");
const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === "string" ? enc.encode(b) : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

interface Signer { kid: string; privateKey: CryptoKey; jwk: JsonWebKey & { kid: string } }
async function makeSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "ES256", use: "sig" } as JsonWebKey & { kid: string };
  return { kid, privateKey: pair.privateKey, jwk };
}

const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: ISS, aud: "authenticated", role: "authenticated", sub: "user-1",
  email: "Sam@LFCrea.com", exp: Math.floor(NOW / 1000) + 3600, iat: Math.floor(NOW / 1000),
  app_metadata: { provider: "google", providers: ["google"] },
  user_metadata: { email_verified: true },
  ...over,
});

async function sign(signer: Signer, claims: object, headerOver: Record<string, unknown> = {}) {
  const header = b64u(JSON.stringify({ alg: "ES256", typ: "JWT", kid: signer.kid, ...headerOver }));
  const payload = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.privateKey, enc.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64u(sig)}`;
}

let signer: Signer;
let other: Signer;
let jwks: { keys: unknown[] };
let jwksCalls = 0;
let jwksDown = false;
let env: Env;
let kv: FakeKV;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetAuthCache();
  signer = await makeSigner("key-1");
  other = await makeSigner("key-attacker");
  jwks = { keys: [signer.jwk] };
  jwksCalls = 0;
  jwksDown = false;
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url) !== JWKS_URL) throw new Error("unexpected fetch " + url);
    jwksCalls++;
    if (jwksDown) throw new Error("network");
    return new Response(JSON.stringify(jwks), { status: 200, headers: { "content-type": "application/json" } });
  });
  kv = new FakeKV();
  env = { LINKS: kv as unknown as KVNamespace, API_KEY: "the-api-key", SUPABASE_URL: SUPABASE, SHORT_BASE_URL: "https://go.test" };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const verify = async (token: string) => verifyAccessToken(token, env, NOW);
const expectDeny = async (token: string, code: string, status = 401) => {
  const r = await verify(token);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.code).toBe(code);
    expect(r.status).toBe(status);
  }
};

describe("verifyAccessToken", () => {
  it("accepts a valid Google token on the allowed domain and lowercases the email", async () => {
    const r = await verify(await sign(signer, goodClaims()));
    expect(r).toEqual({ ok: true, identity: { kind: "user", email: "sam@lfcrea.com", sub: "user-1" } });
  });
  it("rejects expired tokens, with a little clock-skew allowance", async () => {
    await expectDeny(await sign(signer, goodClaims({ exp: Math.floor(NOW / 1000) - 120 })), "token_expired");
    expect((await verify(await sign(signer, goodClaims({ exp: Math.floor(NOW / 1000) - 10 })))).ok).toBe(true);
  });
  it("rejects a token signed by a key that is not in the project's JWKS", async () => {
    await expectDeny(await sign(other, goodClaims(), { kid: "key-1" }), "invalid_token"); // right kid, wrong key
    await expectDeny(await sign(other, goodClaims()), "invalid_token"); // unknown kid
  });
  it("rejects a tampered payload", async () => {
    const [h, , s] = (await sign(signer, goodClaims({ email: "a@lfcrea.com" }))).split(".");
    const evil = b64u(JSON.stringify(goodClaims({ email: "ceo@lfcrea.com" })));
    await expectDeny(`${h}.${evil}.${s}`, "invalid_token");
  });
  it("rejects alg none and HS256 (key-confusion) tokens", async () => {
    const noneH = b64u(JSON.stringify({ alg: "none", typ: "JWT", kid: "key-1" }));
    const p = b64u(JSON.stringify(goodClaims()));
    await expectDeny(`${noneH}.${p}.`, "invalid_token");
    const hsH = b64u(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "key-1" }));
    const mac = await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", enc.encode(JSON.stringify(signer.jwk)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(`${hsH}.${p}`));
    await expectDeny(`${hsH}.${p}.${b64u(mac)}`, "invalid_token");
  });
  it("rejects wrong issuer, audience and role", async () => {
    await expectDeny(await sign(signer, goodClaims({ iss: "https://evil.supabase.co/auth/v1" })), "invalid_token");
    await expectDeny(await sign(signer, goodClaims({ aud: "anon" })), "invalid_token");
    await expectDeny(await sign(signer, goodClaims({ role: "anon" })), "invalid_token");
    await expectDeny(await sign(signer, goodClaims({ sub: "" })), "invalid_token");
    expect((await verify(await sign(signer, goodClaims({ aud: ["authenticated", "x"] })))).ok).toBe(true);
  });
  it("rejects other email domains and lookalikes", async () => {
    for (const email of ["sam@gmail.com", "sam@lfcrea.com.evil.io", "sam@evil-lfcrea.com", "sam@sub.lfcrea.com", "sam@lfcrea.com@evil.io", "lfcrea.com", ""]) {
      await expectDeny(await sign(signer, goodClaims({ email })), "wrong_domain");
    }
    await expectDeny(await sign(signer, goodClaims({ email: undefined })), "wrong_domain");
  });
  it("honours a different ALLOWED_EMAIL_DOMAIN", async () => {
    env.ALLOWED_EMAIL_DOMAIN = "Other.com";
    expect((await verify(await sign(signer, goodClaims({ email: "a@other.com" })))).ok).toBe(true);
    await expectDeny(await sign(signer, goodClaims()), "wrong_domain");
  });
  it("requires a Google sign-in with a verified email (blocks email+password sign-ups)", async () => {
    await expectDeny(await sign(signer, goodClaims({ app_metadata: { provider: "email" } })), "wrong_provider");
    await expectDeny(await sign(signer, goodClaims({ app_metadata: {} })), "wrong_provider");
    await expectDeny(await sign(signer, goodClaims({ user_metadata: { email_verified: false } })), "wrong_provider");
    await expectDeny(await sign(signer, goodClaims({ user_metadata: {} })), "wrong_provider");
  });
  it("rejects malformed tokens", async () => {
    for (const t of ["", "a.b", "a.b.c.d", "not.base64!.x", "e30.e30."]) await expectDeny(t, "invalid_token");
  });
  it("is disabled until SUPABASE_URL is set", async () => {
    env.SUPABASE_URL = "";
    await expectDeny(await sign(signer, goodClaims()), "sign_in_disabled");
  });
  it("reports 503, not 401, when the key endpoint is unreachable", async () => {
    jwksDown = true;
    await expectDeny(await sign(signer, goodClaims()), "auth_unavailable", 503);
  });
  it("caches keys, refetches on an unknown key id, and rate-limits that refetch", async () => {
    const t = await sign(signer, goodClaims());
    await verify(t);
    await verify(t);
    expect(jwksCalls).toBe(1);
    // key rotation: a new kid appears
    const rotated = await makeSigner("key-2");
    jwks = { keys: [signer.jwk, rotated.jwk] };
    const unknownSoon = await verifyAccessToken(await sign(rotated, goodClaims()), env, NOW + 5_000);
    expect(unknownSoon.ok).toBe(false); // within 30 s of the last fetch: no refetch yet
    expect(jwksCalls).toBe(1);
    const afterWindow = await verifyAccessToken(await sign(rotated, goodClaims()), env, NOW + 40_000);
    expect(afterWindow.ok).toBe(true);
    expect(jwksCalls).toBe(2);
  });
  it("rejects a token whose algorithm does not match its key type", async () => {
    jwks = { keys: [{ ...signer.jwk, kty: "RSA" }] };
    await expectDeny(await sign(signer, goodClaims()), "invalid_token");
  });
});

describe("API authentication", () => {
  const call = (headers: Record<string, string>, method = "GET", path = "/api/links") =>
    worker.fetch(new Request("https://go.test" + path, { method, headers }), env);

  it("lets a signed-in @lfcrea.com user use the API with a Bearer token", async () => {
    const token = await sign(signer, goodClaims());
    const res = await call({ authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
  });
  it("still accepts the API key via X-API-Key and as a Bearer value", async () => {
    expect((await call({ "x-api-key": "the-api-key" })).status).toBe(200);
    expect((await call({ authorization: "Bearer the-api-key" })).status).toBe(200);
    expect((await call({ "x-api-key": "wrong" })).status).toBe(401);
    expect((await call({})).status).toBe(401);
  });
  it("answers 401 with a code for bad tokens, and never falls back to the API key path", async () => {
    const bad = await sign(other, goodClaims(), { kid: "key-1" });
    const res = await call({ authorization: `Bearer ${bad}` });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).code).toBe("invalid_token");
    const gmail = await call({ authorization: `Bearer ${await sign(signer, goodClaims({ email: "x@gmail.com" }))}` });
    expect(((await gmail.json()) as any).code).toBe("wrong_domain");
  });
  it("answers 503 (so clients stay signed in) when the sign-in service cannot be reached", async () => {
    jwksDown = true;
    const res = await call({ authorization: `Bearer ${await sign(signer, goodClaims())}` });
    expect(res.status).toBe(503);
  });
  it("works for sign-in only deployments with no API key, and fails closed with neither", async () => {
    env.API_KEY = undefined;
    expect((await call({ authorization: `Bearer ${await sign(signer, goodClaims())}` })).status).toBe(200);
    expect((await call({ "x-api-key": "anything" })).status).toBe(401);
    env.SUPABASE_URL = "";
    expect((await call({ "x-api-key": "anything" })).status).toBe(500);
  });
  it("user tokens can create, rename and delete links like the key can", async () => {
    const auth = { authorization: `Bearer ${await sign(signer, goodClaims())}`, "content-type": "application/json" };
    const made = await worker.fetch(new Request("https://go.test/api/links", { method: "POST", headers: auth, body: JSON.stringify({ url: "https://example.com", alias: "mine" }) }), env);
    expect(made.status).toBe(201);
    const moved = await worker.fetch(new Request("https://go.test/api/links/mine", { method: "PATCH", headers: auth, body: JSON.stringify({ newCode: "yours" }) }), env);
    expect(moved.status).toBe(200);
    expect((await worker.fetch(new Request("https://go.test/api/links/yours", { method: "DELETE", headers: auth }), env)).status).toBe(200);
  });
  it("sends CORS headers on auth failures for the extension origin", async () => {
    env.ALLOWED_ORIGINS = "chrome-extension://abc";
    const res = await call({ origin: "chrome-extension://abc", authorization: "Bearer a.b.c" });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("chrome-extension://abc");
  });
  it("the public redirect route needs no sign-in", async () => {
    await call({ "x-api-key": "the-api-key", "content-type": "application/json" }, "POST");
    expect((await worker.fetch(new Request("https://go.test/nothing"), env)).status).toBe(404);
  });
});
