export interface Env {
  LINKS: KVNamespace;
  /** Worker secret. Required; the API fails closed when it is missing. */
  API_KEY?: string;
  SHORT_BASE_URL?: string;
  /** Comma-separated browser origins allowed to call /api/*. */
  ALLOWED_ORIGINS?: string;
  /** Worker secret keying the PIN hashes. PIN locks are unavailable without it. */
  PIN_SECRET?: string;
  /** Durable Object namespace counting wrong PIN guesses (class PinGuard). */
  PIN_GUARD?: DurableObjectNamespace;
}
