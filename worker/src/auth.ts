// Verifies "LF ID" sign-ins: access tokens issued by the Supabase Auth project in
// SUPABASE_URL after a Google login. Only ES256/RS256 tokens signed by a key in the
// project's JWKS are accepted (never HS256, never "none"), and the account must be a
// verified Google account on ALLOWED_EMAIL_DOMAIN.
//
// Supabase docs (Auth > JWTs): the public keys are served at
// <project>/auth/v1/.well-known/jwks.json and must not be cached for longer than
// 10 minutes. That endpoint returns no keys unless the project uses asymmetric
// JWT signing keys.

import type { Env } from "./types";

export interface UserIdentity {
  kind: "user";
  email: string;
  sub: string;
}

export type VerifyResult =
  | { ok: true; identity: UserIdentity }
  | { ok: false; status: 401 | 503; code: string; message: string };

const JWKS_TTL_MS = 5 * 60 * 1000;
const JWKS_MIN_REFETCH_MS = 30 * 1000; // at most one extra fetch per 30 s for unknown key ids
const CLOCK_SKEW_S = 30;

interface Jwk {
  kty: string;
  kid?: string;
  crv?: string;
  alg?: string;
  [k: string]: unknown;
}
interface JwksCache {
  url: string;
  keys: Jwk[];
  fetchedAt: number;
}
let cache: JwksCache | null = null;

/** For tests. */
export function resetAuthCache() {
  cache = null;
}

const fromB64 = (s: string): Uint8Array => {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const decodeJson = (s: string): any => JSON.parse(new TextDecoder().decode(fromB64(s)));

export const looksLikeJwt = (token: string): boolean => /^[\w-]+\.[\w-]+\.[\w-]*$/.test(token);

export const authEnabled = (env: Env): boolean => !!env.SUPABASE_URL?.trim();
export const issuerOf = (env: Env): string => `${env.SUPABASE_URL!.trim().replace(/\/+$/, "")}/auth/v1`;
export const allowedDomain = (env: Env): string => (env.ALLOWED_EMAIL_DOMAIN?.trim() || "lfcrea.com").toLowerCase();

async function loadKeys(env: Env, kid: string, now: number): Promise<Jwk[] | "unavailable"> {
  const url = `${issuerOf(env)}/.well-known/jwks.json`;
  const fresh = cache && cache.url === url && now - cache.fetchedAt < JWKS_TTL_MS;
  const hit = fresh && cache!.keys.some((k) => k.kid === kid);
  if (hit) return cache!.keys;
  // Unknown key id (e.g. after a key rotation): refetch, but not more than every 30 s.
  if (cache && cache.url === url && fresh && now - cache.fetchedAt < JWKS_MIN_REFETCH_MS) return cache.keys;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return "unavailable";
    const body = (await res.json()) as { keys?: Jwk[] };
    cache = { url, keys: Array.isArray(body.keys) ? body.keys : [], fetchedAt: now };
    return cache.keys;
  } catch {
    return "unavailable";
  }
}

const deny = (code: string, message: string): VerifyResult => ({ ok: false, status: 401, code, message });

export async function verifyAccessToken(token: string, env: Env, now = Date.now()): Promise<VerifyResult> {
  if (!authEnabled(env)) return deny("sign_in_disabled", "Sign-in is not enabled on this server");
  const parts = token.split(".");
  if (parts.length !== 3) return deny("invalid_token", "Malformed token");

  let header: any;
  let claims: any;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return deny("invalid_token", "Malformed token");
  }
  // Only asymmetric algorithms: this is what stops "alg: none" and HS256 key-confusion tricks.
  if (header.alg !== "ES256" && header.alg !== "RS256") return deny("invalid_token", "Unsupported token algorithm");
  if (typeof header.kid !== "string" || !header.kid) return deny("invalid_token", "Token has no key id");

  const keys = await loadKeys(env, header.kid, now);
  if (keys === "unavailable") {
    return { ok: false, status: 503, code: "auth_unavailable", message: "Could not reach the sign-in service to check your session" };
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return deny("invalid_token", "Unknown signing key");
  const wantKty = header.alg === "ES256" ? "EC" : "RSA";
  if (jwk.kty !== wantKty || (header.alg === "ES256" && jwk.crv !== "P-256")) {
    return deny("invalid_token", "Signing key does not match the token algorithm");
  }

  let valid = false;
  try {
    const key =
      header.alg === "ES256"
        ? await crypto.subtle.importKey("jwk", jwk as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
        : await crypto.subtle.importKey("jwk", jwk as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify(
      header.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" },
      key,
      fromB64(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) return deny("invalid_token", "Bad token signature");

  const nowS = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < nowS) return deny("token_expired", "Your session has expired. Sign in again");
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > nowS) return deny("invalid_token", "Token is not valid yet");
  if (claims.iss !== issuerOf(env)) return deny("invalid_token", "Token was not issued by this sign-in service");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes("authenticated") || claims.role !== "authenticated") return deny("invalid_token", "Not a signed-in user token");
  if (typeof claims.sub !== "string" || !claims.sub) return deny("invalid_token", "Token has no user");

  // The account: a Google-verified address on the allowed domain.
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const [local, domain, ...rest] = email.split("@");
  if (!local || !domain || rest.length > 0 || domain !== allowedDomain(env)) {
    return deny("wrong_domain", `Only @${allowedDomain(env)} accounts can use this`);
  }
  if (claims.app_metadata?.provider !== "google" || claims.user_metadata?.email_verified !== true) {
    return deny("wrong_provider", "Sign in with your Google account");
  }
  return { ok: true, identity: { kind: "user", email, sub: claims.sub } };
}
