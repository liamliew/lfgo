export interface Env {
  LINKS: KVNamespace;
  /** Worker secret. Required; the API fails closed when it is missing. */
  API_KEY?: string;
  SHORT_BASE_URL?: string;
  /** Comma-separated browser origins allowed to call /api/*. */
  ALLOWED_ORIGINS?: string;
  /** Supabase project URL (the "LF ID" project), e.g. https://abcd.supabase.co. Empty disables Google sign-in. */
  SUPABASE_URL?: string;
  /** Email domain allowed to sign in with Google. Defaults to lfcrea.com. */
  ALLOWED_EMAIL_DOMAIN?: string;
  /** Worker secret keying the PIN hashes. PIN locks are unavailable without it. */
  PIN_SECRET?: string;
  /** Durable Object namespace counting wrong PIN guesses (class PinGuard). */
  PIN_GUARD?: DurableObjectNamespace;
}
