// Public settings for Google sign-in ("LF ID"): the LF Creative Supabase project. These
// are not secrets: the project URL and the *publishable* key are meant to ship in client
// code. Never put a secret or service-role key here (a test enforces the key format).
// Leave both empty to turn the Google button off (the API key still works).
export const SUPABASE_URL = "https://vxgtywdqijtfnkgyubkh.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_SiacCN613xiw-7RZvtt1wg__R0Zte_u";

// Only accounts on this email domain are accepted (the Worker enforces it too).
export const ALLOWED_DOMAIN = "lfcrea.com";
