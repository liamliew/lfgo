// Pure validation helpers. No Worker APIs, so they are unit-testable.

export const ALIAS_MIN = 3;
export const ALIAS_MAX = 32;
export const URL_MAX = 2048;
export const GENERATED_LENGTH = 7;

// Paths the Worker itself serves or that browsers/crawlers probe for.
export const RESERVED = new Set([
  "api", "admin", "www", "app", "dashboard", "login", "logout", "auth",
  "static", "assets", "health", "status", "index", "favicon", "favicon-ico",
  "robots", "robots-txt", "sitemap", "null", "undefined", "new", "edit",
  "delete", "settings", "links", "link",
]);

const ALIAS_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function normalizeCode(input: string): string {
  return input.trim().toLowerCase();
}

/** Returns an error message, or null when `alias` (already normalised) is usable. */
export function validateAlias(alias: string): string | null {
  if (alias.length < ALIAS_MIN || alias.length > ALIAS_MAX) {
    return `Alias must be ${ALIAS_MIN}-${ALIAS_MAX} characters`;
  }
  if (!ALIAS_RE.test(alias)) {
    return "Alias may only contain a-z, 0-9 and hyphens, and cannot start or end with a hyphen";
  }
  if (alias.includes("--")) {
    return "Alias cannot contain consecutive hyphens";
  }
  if (RESERVED.has(alias)) {
    return `"${alias}" is a reserved word`;
  }
  return null;
}

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

/** Accepts only absolute http(s) URLs that do not point back at the shortener. */
export function validateUrl(raw: unknown, selfHost: string): UrlCheck {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "url is required" };
  }
  const trimmed = raw.trim();
  if (trimmed.length > URL_MAX) {
    return { ok: false, error: `url must be at most ${URL_MAX} characters` };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "url is not a valid absolute URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "url must start with http:// or https://" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "url must not contain credentials" };
  }
  if (parsed.hostname.toLowerCase() === selfHost.toLowerCase()) {
    return { ok: false, error: "url cannot point at the shortener itself" };
  }
  return { ok: true, url: parsed.toString() };
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Random lowercase-alphanumeric code; rejection sampling avoids modulo bias. */
export function generateCode(length = GENERATED_LENGTH): string {
  let out = "";
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit && out.length < length) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}
