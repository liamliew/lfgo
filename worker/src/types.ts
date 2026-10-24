export interface Env {
  LINKS: KVNamespace;
  /** Worker secret. Required; the API fails closed when it is missing. */
  API_KEY?: string;
  SHORT_BASE_URL?: string;
  /** Comma-separated browser origins allowed to call /api/*. */
  ALLOWED_ORIGINS?: string;
  /** Supabase project URL (the "LF ID" project), e.g. https://abcd.supabase.co. Empty disables Google sign-in. */
  SUPABASE_URL?: string;
  /**
   * The project's publishable (public) key. Only needed for projects that still sign tokens
   * with the legacy shared-secret (HS256) key: those tokens are checked by asking the
   * Auth server (GET /auth/v1/user), which needs this as its `apikey`.
   */
  SUPABASE_PUBLISHABLE_KEY?: string;
  /** Email domain allowed to sign in with Google. Defaults to lfcrea.com. */
  ALLOWED_EMAIL_DOMAIN?: string;
  /** Worker secret keying the PIN hashes. PIN locks are unavailable without it. */
  PIN_SECRET?: string;
  /** Durable Object namespace counting wrong PIN guesses (class PinGuard). */
  PIN_GUARD?: DurableObjectNamespace;
}
