// The files the browser loads, shared by the Safari build and its tests. The Chrome
// release zip lists the same files in .github/workflows/release.yml.
export const EXTENSION_FILES = [
  "background.js", "shared.js", "auth.js", "config.js", "qr.js", "ui.js",
  "popup.html", "popup.css", "popup.js",
  "manage.html", "manage.css", "manage.js",
  "options.html", "options.css", "options.js",
  "theme.css", "icons", "fonts", "vendor",
];

// Safari only: the content script that finishes the tab-based Google sign-in.
export const SAFARI_ONLY_FILES = ["auth-bridge.js"];
