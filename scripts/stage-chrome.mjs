// Copies the Chrome extension files (as shipped in the release zip) into a folder.
//   node scripts/stage-chrome.mjs <dir>
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_FILES } from "./files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2];
if (!out) throw new Error("usage: stage-chrome.mjs <dir>");
mkdirSync(out, { recursive: true });
for (const f of ["manifest.json", ...EXTENSION_FILES]) cpSync(join(root, f), join(out, f), { recursive: true });
