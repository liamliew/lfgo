// Release checks used by .github/workflows/publish-crx.yml. Each exits non-zero with a reason.
//   node scripts/check-release.mjs update-url <expected-update-url>
//   EXTENSION_PEM=... node scripts/check-release.mjs key
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

/** Returns an error message, or null when manifest.update_url is exactly the hosted update.xml. */
export function checkUpdateUrl(manifest, expected) {
  if (typeof manifest.update_url !== "string" || manifest.update_url === "") {
    return `manifest.json has no update_url. Add "update_url": "${expected}" (Chrome needs it to update a self-hosted extension).`;
  }
  if (manifest.update_url !== expected) {
    return `manifest.json update_url is ${manifest.update_url} but the update.xml is hosted at ${expected}.`;
  }
  if (!expected.startsWith("https://")) return "update_url must be HTTPS.";
  return null;
}

/** Returns an error message, or null when the PEM is the private half of manifest.key. */
export function checkKey(pem, manifestKey) {
  let derBase64;
  try {
    derBase64 = createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" }).toString("base64");
  } catch {
    return "EXTENSION_PEM is not a readable private key (expected the full .pem text, including the BEGIN/END lines).";
  }
  return derBase64 === manifestKey
    ? null
    : "EXTENSION_PEM is not the key behind this extension's id (it does not match the \"key\" in manifest.json). Signing with it would create a different extension.";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const [mode, arg] = process.argv.slice(2);
  let problem;
  if (mode === "update-url") problem = checkUpdateUrl(manifest, arg ?? "");
  else if (mode === "key") problem = checkKey(process.env.EXTENSION_PEM ?? "", manifest.key);
  else throw new Error("usage: check-release.mjs update-url <url> | key");
  if (problem) {
    console.error(`::error::${problem}`);
    process.exit(1);
  }
  console.log("ok");
}
