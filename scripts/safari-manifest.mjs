import { AUTH_DONE_PATH } from "../auth.js";

/**
 * The Chrome manifest, adjusted for Safari (see Apple's "Assessing your Safari web
 * extension's browser compatibility"):
 *  - `key` and `update_url` removed (Chrome-only; Safari assigns its own per-install address and
 *    updates through the App Store);
 *  - `identity` removed (unsupported): sign-in runs in a tab and returns to the short
 *    domain's /auth/done page, which `auth-bridge.js` reports back;
 *  - host access to the short domain, so API calls are not blocked by CORS (the
 *    extension's address changes per install, so it cannot be allow-listed in the Worker);
 *  - background declared as a non-persistent script.
 */
export function toSafariManifest(manifest, { shortBase = "https://go.lfcrea.com" } = {}) {
  const origin = new URL(shortBase).origin;
  const out = structuredClone(manifest);
  delete out.key;
  delete out.update_url; // Apple: not supported; Safari extensions update through the App Store
  out.permissions = out.permissions.filter((p) => p !== "identity");
  out.host_permissions = [`${origin}/*`];
  out.content_scripts = [
    {
      matches: [`${origin}${AUTH_DONE_PATH}*`],
      js: ["auth-bridge.js"],
      run_at: "document_start",
    },
  ];
  out.background = { scripts: [manifest.background.service_worker], persistent: false };
  return out;
}
