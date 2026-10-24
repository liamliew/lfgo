// Prints the extension id derived from the "key" in manifest.json (first 128 bits of the
// SHA-256 of the public key, written with the letters a-p).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function extensionId(publicKeyBase64) {
  const hex = createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  console.log(extensionId(manifest.key));
}
