import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthError, challengeFor, connect, getAccessToken, getSession, loadAuthConfig, randomVerifier, signInWithGoogle, signOut,
} from "../auth.js";
import { ApiError, createClient, describeError } from "../shared.js";

const CFG = { url: "https://lfid.supabase.co", key: "sb_publishable_test", enabled: true, domain: "lfcrea.com" };
const REDIRECT = "https://bfdicajogngofgmdnilbhmpliocicbpi.chromiumapp.org/";
const NOW = Date.parse("2026-10-24T10:00:00Z");
const nowS = Math.floor(NOW / 1000);

function area(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (defaults) => ({ ...defaults, ...data }),
    set: async (v) => void Object.assign(data, v),
    remove: async (k) => void delete data[k],
  };
}
const jwt = (payload) => `e30.${btoa(JSON.stringify(payload)).replace(/=+$/, "")}.sig`;
const session = (over = {}) => ({ access_token: "acc-1", refresh_token: "ref-1", expires_at: nowS + 3600, email: "sam@lfcrea.com", ...over });
const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });
const serial = () => {
  let chain = Promise.resolve();
  return (_name, fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
};

describe("PKCE helpers", () => {
  it("makes a 43-character base64url verifier and its S256 challenge", async () => {
    const v = randomVerifier();
    assert.match(v, /^[A-Za-z0-9_-]{43}$/);
    // RFC 7636 appendix B test vector
    assert.equal(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert.notEqual(randomVerifier(), randomVerifier());
  });
});

describe("loadAuthConfig", () => {
  it("is disabled when nothing is configured, and takes stored overrides", async () => {
    assert.equal((await loadAuthConfig(area())).enabled, false);
    const cfg = await loadAuthConfig(area({ supabaseUrl: "https://x.supabase.co/", supabaseKey: "k" }));
    assert.deepEqual([cfg.url, cfg.key, cfg.enabled, cfg.domain], ["https://x.supabase.co", "k", true, "lfcrea.com"]);
  });
});

describe("signInWithGoogle", () => {
  function setup({ finalUrl, exchange } = {}) {
    const a = area();
    const calls = { launch: null, fetch: [] };
    return {
      a,
      calls,
      deps: {
        area: a,
        config: CFG,
        redirectUrl: REDIRECT,
        now: () => NOW,
        launch: async (opts) => {
          calls.launch = opts;
          return typeof finalUrl === "function" ? finalUrl(opts) : finalUrl;
        },
        fetchImpl: async (url, init) => {
          calls.fetch.push({ url, init, body: JSON.parse(init.body) });
          return exchange ?? respond(200, { access_token: jwt({ email: "sam@lfcrea.com" }), refresh_token: "ref-1", expires_in: 3600, user: { email: "Sam@LFCrea.com" } });
        },
      },
    };
  }

  it("opens the Supabase authorize URL with PKCE and the extension redirect, then exchanges the code", async () => {
    const { a, calls, deps } = setup({ finalUrl: `${REDIRECT}?code=the-code` });
    const s = await signInWithGoogle(deps);
    const u = new URL(calls.launch.url);
    assert.equal(calls.launch.interactive, true);
    assert.equal(`${u.origin}${u.pathname}`, "https://lfid.supabase.co/auth/v1/authorize");
    assert.equal(u.searchParams.get("provider"), "google");
    assert.equal(u.searchParams.get("redirect_to"), REDIRECT);
    assert.equal(u.searchParams.get("code_challenge_method"), "s256");
    assert.equal(u.searchParams.get("hd"), "lfcrea.com");
    const ex = calls.fetch[0];
    assert.equal(ex.url, "https://lfid.supabase.co/auth/v1/token?grant_type=pkce");
    assert.equal(ex.init.method, "POST");
    assert.equal(ex.init.headers.apikey, CFG.key);
    assert.equal(ex.body.auth_code, "the-code");
    // the challenge sent to the authorize endpoint must be the hash of the verifier sent in the exchange
    assert.equal(await challengeFor(ex.body.code_verifier), u.searchParams.get("code_challenge"));
    assert.equal(s.email, "sam@lfcrea.com");
    assert.equal(s.expires_at, nowS + 3600);
    assert.deepEqual(await getSession(a), s);
  });
  it("uses a fresh verifier every time", async () => {
    const one = setup({ finalUrl: `${REDIRECT}?code=a` });
    const two = setup({ finalUrl: `${REDIRECT}?code=b` });
    await signInWithGoogle(one.deps);
    await signInWithGoogle(two.deps);
    assert.notEqual(one.calls.fetch[0].body.code_verifier, two.calls.fetch[0].body.code_verifier);
  });
  it("explains a failed or refused login without saving anything", async () => {
    const denied = setup({ finalUrl: `${REDIRECT}?error=server_error&error_description=Only+company+emails+are+allowed` });
    await assert.rejects(signInWithGoogle(denied.deps), (e) => e instanceof AuthError && e.code === "denied" && /company emails/.test(e.message));
    assert.equal(await getSession(denied.a), null);
    const hashErr = setup({ finalUrl: `${REDIRECT}#error=access_denied&error_description=nope` });
    await assert.rejects(signInWithGoogle(hashErr.deps), (e) => e.code === "denied" && /nope/.test(e.message));
  });
  it("treats closing the window as a cancel", async () => {
    const closed = setup({ finalUrl: () => { throw new Error("The user did not approve access."); } });
    await assert.rejects(signInWithGoogle(closed.deps), (e) => e.code === "cancelled");
    await assert.rejects(signInWithGoogle(setup({ finalUrl: undefined }).deps), (e) => e.code === "cancelled");
  });
  it("rejects an account outside the domain even if the server returned a session", async () => {
    const { a, deps } = setup({
      finalUrl: `${REDIRECT}?code=c`,
      exchange: respond(200, { access_token: jwt({ email: "x@gmail.com" }), refresh_token: "r", expires_in: 3600, user: { email: "x@gmail.com" } }),
    });
    await assert.rejects(signInWithGoogle(deps), (e) => e.code === "wrong_domain" && /@lfcrea\.com/.test(e.message));
    assert.equal(await getSession(a), null);
  });
  it("reports a failed code exchange and a missing config", async () => {
    const bad = setup({ finalUrl: `${REDIRECT}?code=c`, exchange: respond(400, { error_description: "invalid flow state" }) });
    await assert.rejects(signInWithGoogle(bad.deps), (e) => e.code === "exchange_failed" && /invalid flow state/.test(e.message));
    await assert.rejects(signInWithGoogle({ area: area(), config: { ...CFG, enabled: false } }), (e) => e.code === "not_configured");
  });
  it("reads the email from the token when the response has no user", async () => {
    const { deps } = setup({
      finalUrl: `${REDIRECT}?code=c`,
      exchange: respond(200, { access_token: jwt({ email: "pat@lfcrea.com" }), refresh_token: "r", expires_in: 100 }),
    });
    assert.equal((await signInWithGoogle(deps)).email, "pat@lfcrea.com");
  });
});

describe("getAccessToken", () => {
  const deps = (a, fetchImpl, extra = {}) => ({ area: a, config: CFG, now: () => NOW, lock: serial(), fetchImpl, ...extra });

  it("returns null with no session, and the stored token while it is fresh", async () => {
    assert.equal(await getAccessToken(deps(area(), async () => assert.fail("no fetch"))), null);
    const a = area({ session: session() });
    assert.equal(await getAccessToken(deps(a, async () => assert.fail("no fetch"))), "acc-1");
  });
  it("refreshes a token that expires within a minute and stores the new session", async () => {
    const a = area({ session: session({ expires_at: nowS + 30 }) });
    const seen = [];
    const token = await getAccessToken(deps(a, async (url, init) => {
      seen.push({ url, init, body: JSON.parse(init.body) });
      return respond(200, { access_token: "acc-2", refresh_token: "ref-2", expires_in: 3600 });
    }));
    assert.equal(token, "acc-2");
    assert.equal(seen[0].url, "https://lfid.supabase.co/auth/v1/token?grant_type=refresh_token");
    assert.deepEqual(seen[0].body, { refresh_token: "ref-1" });
    assert.equal(seen[0].init.headers.apikey, CFG.key);
    const s = await getSession(a);
    assert.deepEqual([s.access_token, s.refresh_token, s.expires_at, s.email], ["acc-2", "ref-2", nowS + 3600, "sam@lfcrea.com"]);
  });
  it("shares one refresh between simultaneous callers (refresh tokens are single use)", async () => {
    const a = area({ session: session({ expires_at: nowS - 10 }) });
    let calls = 0;
    const d = deps(a, async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return respond(200, { access_token: "acc-2", refresh_token: "ref-2", expires_in: 3600 });
    });
    const tokens = await Promise.all([getAccessToken(d), getAccessToken(d), getAccessToken(d), getAccessToken(d)]);
    assert.deepEqual(tokens, ["acc-2", "acc-2", "acc-2", "acc-2"]);
    assert.equal(calls, 1);
  });
  it("signs out when the refresh token is rejected, but keeps the session when the service is down", async () => {
    const a = area({ session: session({ expires_at: nowS - 10 }) });
    assert.equal(await getAccessToken(deps(a, async () => respond(400, { error: "invalid_grant" }))), null);
    assert.equal(await getSession(a), null);

    const b = area({ session: session({ expires_at: nowS - 10 }) });
    await assert.rejects(getAccessToken(deps(b, async () => { throw new TypeError("offline"); })), (e) => e.code === "network");
    await assert.rejects(getAccessToken(deps(b, async () => respond(503, {}))), (e) => e.code === "network");
    assert.notEqual(await getSession(b), null);
  });
});

describe("signOut", () => {
  it("clears the session and tells the server (best effort)", async () => {
    const a = area({ session: session() });
    const seen = [];
    await signOut({ area: a, config: CFG, fetchImpl: async (url, init) => { seen.push({ url, init }); return respond(204, null); } });
    assert.equal(await getSession(a), null);
    assert.equal(seen[0].url, "https://lfid.supabase.co/auth/v1/logout");
    assert.equal(seen[0].init.headers.authorization, "Bearer acc-1");
  });
  it("still signs out locally when the server cannot be reached", async () => {
    const a = area({ session: session() });
    await signOut({ area: a, config: CFG, fetchImpl: async () => { throw new Error("offline"); } });
    assert.equal(await getSession(a), null);
  });
});

describe("connect and the client", () => {
  it("prefers the Google session, falls back to the API key, and reports nothing set up", async () => {
    const both = await connect(area({ session: session(), apiKey: "k", supabaseUrl: CFG.url, supabaseKey: CFG.key }));
    assert.equal(both.mode, "google");
    assert.equal(both.email, "sam@lfcrea.com");
    assert.equal(both.authEnabled, true);
    assert.equal((await connect(area({ apiKey: "k" }))).mode, "key");
    const none = await connect(area());
    assert.deepEqual([none.mode, none.client, none.authEnabled], [null, null, false]);
  });
  it("sends the Bearer token when signed in, the key otherwise, and refuses when neither", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push(init.headers); return respond(200, { links: [] }); };
    await createClient({ base: "https://go.test", apiKey: "k", getToken: async () => "tok", fetchImpl }).list();
    await createClient({ base: "https://go.test", apiKey: "k", fetchImpl }).list();
    await createClient({ base: "https://go.test", apiKey: "k", getToken: async () => null, fetchImpl }).list(); // signed out but has a key
    assert.deepEqual(seen.map((h) => Object.keys(h).filter((k) => k !== "content-type")), [["authorization"], ["x-api-key"], ["x-api-key"]]);
    assert.equal(seen[0].authorization, "Bearer tok");
    await assert.rejects(createClient({ base: "https://go.test", getToken: async () => null, fetchImpl }).list(), (e) => e instanceof ApiError && e.code === "signed_out");
    await assert.rejects(
      createClient({ base: "https://go.test", getToken: async () => { throw new AuthError("network", "x"); }, fetchImpl }).list(),
      (e) => e.code === "network",
    );
  });
  it("has plain-language messages for sign-in errors", () => {
    assert.match(describeError(new ApiError(401, "signed_out", "x"), "b"), /signed out/);
    assert.match(describeError(new ApiError(401, "token_expired", "x"), "b"), /sign in again/i);
    assert.match(describeError(new ApiError(401, "wrong_domain", "Only @lfcrea.com accounts can use this"), "b"), /lfcrea\.com/);
    assert.match(describeError(new ApiError(503, "auth_unavailable", "x"), "b"), /Try again/);
    assert.match(describeError(new ApiError(401, "sign_in_disabled", "x"), "b"), /API key/);
  });
});
