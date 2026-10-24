// PIN lock primitives. A PIN is never stored: we keep a per-link random salt and
// an HMAC-SHA256 of "salt:pin" keyed with the PIN_SECRET Worker secret. Without
// that secret a leaked KV namespace cannot be brute-forced (6 digits is only a
// million guesses, so a plain or slow hash would not protect it). HMAC is also
// cheap enough for the Workers Free plan's 10 ms CPU limit, unlike PBKDF2.
// The hash does not include the link code, so renaming a link keeps its PIN.

export const PIN_RE = /^\d{6}$/;

export interface Lock {
  /** Random salt, base64url. Also names this lock's attempt-counting object. */
  s: string;
  /** HMAC-SHA256(PIN_SECRET, `${s}:${pin}`), base64url. */
  h: string;
}

const enc = new TextEncoder();

const toB64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromB64 = (s: string): Uint8Array => {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const hmacKey = (secret: string, usage: "sign" | "verify") =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

export async function makeLock(pin: string, secret: string): Promise<Lock> {
  const s = toB64(crypto.getRandomValues(new Uint8Array(16)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(`${s}:${pin}`));
  return { s, h: toB64(new Uint8Array(sig)) };
}

/** Constant-time check (crypto.subtle.verify compares the MACs in constant time). */
export async function verifyPin(lock: Lock, pin: string, secret: string): Promise<boolean> {
  if (!PIN_RE.test(pin)) return false;
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), fromB64(lock.h), enc.encode(`${lock.s}:${pin}`));
  } catch {
    return false;
  }
}
