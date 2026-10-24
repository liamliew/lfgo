// Builds dist/safari-extension/: the extension folder to hand to Apple's converter
// (`xcrun safari-web-extension-converter`, macOS with Xcode only; see scripts/safari-convert.sh).
//   node scripts/build-safari.mjs [outDir]
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_FILES, SAFARI_ONLY_FILES } from "./files.mjs";
import { toSafariManifest } from "./safari-manifest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? join(root, "dist", "safari-extension");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of [...EXTENSION_FILES, ...SAFARI_ONLY_FILES]) {
  cpSync(join(root, f), join(out, f), { recursive: true });
}
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(toSafariManifest(manifest), null, 2)}\n`);
console.log(`Safari extension folder written to ${out}`);
