export interface Env {
  LINKS: KVNamespace;
  /** Worker secret. Required; the API fails closed when it is missing. */
  API_KEY?: string;
  SHORT_BASE_URL?: string;
  /** Comma-separated browser origins allowed to call /api/*. */
  ALLOWED_ORIGINS?: string;
}
