// Public settings for Google sign-in ("LF ID"). These are not secrets: the project URL
// and the *publishable* key are meant to ship in client code. Never put a secret or
// service-role key here. Leave both empty to turn the Google button off (the API key
// still works).
export const SUPABASE_URL = "";
export const SUPABASE_PUBLISHABLE_KEY = "";

// Only accounts on this email domain are accepted (the server enforces it too).
export const ALLOWED_DOMAIN = "lfcrea.com";
