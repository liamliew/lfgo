import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXTENSION_FILES, SAFARI_ONLY_FILES } from "../scripts/files.mjs";
import { toSafariManifest } from "../scripts/safari-manifest.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));

describe("Safari manifest", () => {
  const safari = toSafariManifest(manifest);

  it("drops what Safari lacks or must assign itself: key and identity", () => {
    assert.equal(safari.key, undefined);
    assert.ok(!safari.permissions.includes("identity"));
    assert.deepEqual([...safari.permissions].sort(), ["activeTab", "storage"]);
  });

  it("does not change the Chrome manifest it was derived from", () => {
    assert.ok(manifest.key && manifest.permissions.includes("identity"));
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_scripts, undefined, "Chrome must not get a content script on the short domain");
  });

  it("gets host access to the short domain only, and the bridge runs on the sign-in landing page only", () => {
    assert.deepEqual(safari.host_permissions, ["https://go.lfcrea.com/*"]);
    assert.equal(safari.content_scripts.length, 1);
    assert.deepEqual(safari.content_scripts[0].matches, ["https://go.lfcrea.com/auth/done*"]);
    assert.deepEqual(safari.content_scripts[0].js, ["auth-bridge.js"]);
  });

  it("declares a non-persistent background script (Apple: service workers vary, iOS needs persistent: false)", () => {
    assert.deepEqual(safari.background, { scripts: ["background.js"], persistent: false });
  });

  it("follows a different short domain", () => {
    const s = toSafariManifest(manifest, { shortBase: "https://links.example.com/x" });
    assert.deepEqual(s.host_permissions, ["https://links.example.com/*"]);
    assert.deepEqual(s.content_scripts[0].matches, ["https://links.example.com/auth/done*"]);
  });
});

describe("Safari build", () => {
  const out = mkdtempSync(join(tmpdir(), "lfc-safari-"));
  it("copies every file the manifest and pages need, plus the bridge", () => {
    execFileSync("node", ["scripts/build-safari.mjs", out], { cwd: new URL(".", root).pathname });
    const built = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    const needed = [
      ...built.background.scripts, built.action.default_popup, built.options_page,
      ...Object.values(built.icons), ...Object.values(built.action.default_icon),
      ...built.content_scripts.flatMap((c) => c.js),
    ];
    for (const f of needed) assert.ok(existsSync(join(out, f)), `missing ${f}`);
    for (const f of [...EXTENSION_FILES, ...SAFARI_ONLY_FILES]) assert.ok(existsSync(join(out, f)), `missing ${f}`);
    rmSync(out, { recursive: true, force: true });
  });

  it("ships the same files as the Chrome release zip (plus the bridge)", () => {
    const workflow = readFileSync(new URL(".github/workflows/release.yml", root), "utf8");
    const zipped = (workflow.match(/zip -r[^\n]*\\\n([\s\S]*?)\n\n/)?.[0] ?? "")
      .replace(/zip -r[^\n]*\n/, "").split(/\s+/).filter((t) => t && t !== "\\" && t !== "INSTALL.txt" && t !== "manifest.json");
    assert.deepEqual([...zipped].sort(), [...EXTENSION_FILES].sort());
  });
});
