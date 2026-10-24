import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
const html = (f) => readFileSync(new URL(f, root), "utf8");

describe("manifest", () => {
  it("is MV3, named LFC Tools, and asks for exactly activeTab + storage + identity (Google sign-in)", () => {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.name, "LFC Tools");
    assert.deepEqual([...manifest.permissions].sort(), ["activeTab", "identity", "storage"]);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_security_policy, undefined, "keep the strict default CSP");
  });
  it("pins the extension id the Worker allows", () => {
    assert.ok(manifest.key && manifest.key.length > 300);
  });
  it("only references files that exist", () => {
    const files = [
      manifest.background.service_worker, manifest.action.default_popup, manifest.options_page,
      ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ];
    for (const f of files) assert.ok(existsSync(new URL(f, root)), `missing ${f}`);
  });
  it("defines the keyboard shortcut with Ctrl or Alt", () => {
    const key = manifest.commands._execute_action.suggested_key.default;
    assert.match(key, /(Ctrl|Alt)/);
  });
});

describe("pages", () => {
  for (const page of ["popup.html", "manage.html", "options.html"]) {
    it(`${page}: no inline scripts, local assets only`, () => {
      const src = html(page);
      assert.doesNotMatch(src, /<script(?![^>]*\bsrc=)[^>]*>/i, "inline script would violate the extension CSP");
      assert.doesNotMatch(src, /onclick=|onload=|javascript:/i);
      assert.doesNotMatch(src, /(src|href)="https?:/i, "no remote resources");
      for (const m of src.matchAll(/(?:src|href)="([^"#]+)"/g)) {
        if (m[1] === "#") continue;
        assert.ok(existsSync(new URL(m[1], root)), `${page} references missing ${m[1]}`);
      }
    });
  }
  it("bundles Inter locally", () => {
    const css = readFileSync(new URL("theme.css", root), "utf8");
    assert.match(css, /font-family: "Inter"/);
    assert.doesNotMatch(css, /googleapis|gstatic|https?:\/\//);
    for (const m of css.matchAll(/url\((fonts\/[^)]+)\)/g)) assert.ok(existsSync(new URL(m[1], root)), m[1]);
  });
});

describe("release zip", () => {
  const workflow = readFileSync(new URL(".github/workflows/release.yml", root), "utf8");
  const zipped = (workflow.match(/zip -r[^\n]*\\\n([\s\S]*?)\n\n/)?.[0] ?? "")
    .replace(/zip -r[^\n]*\n/, "")
    .split(/\s+/)
    .filter((t) => t && t !== "\\");
  const covered = (file) => zipped.some((z) => file === z || file.startsWith(`${z}/`));

  it("lists the files", () => assert.ok(zipped.length > 10, `parsed ${zipped.length} entries`));

  it("includes every file the extension loads at runtime", () => {
    const needed = new Set(["manifest.json"]);
    const scan = (file) => {
      const text = readFileSync(new URL(file, root), "utf8");
      for (const m of text.matchAll(/(?:src|href)="([^"#:]+)"/g)) needed.add(m[1]);
      for (const m of text.matchAll(/from "\.\/([^"]+)"/g)) needed.add(m[1]);
      for (const m of text.matchAll(/url\(([^)]+)\)/g)) needed.add(m[1]);
    };
    for (const page of ["popup.html", "manage.html", "options.html"]) { needed.add(page); scan(page); }
    for (const f of ["popup.js", "manage.js", "options.js", "shared.js", "auth.js", "config.js", "qr.js", "ui.js", "theme.css"]) { needed.add(f); scan(f); }
    needed.add(manifest.background.service_worker);
    for (const f of Object.values(manifest.icons)) needed.add(f);
    for (const f of needed) {
      if (!existsSync(new URL(f, root))) continue; // e.g. a string that only looks like a path
      assert.ok(covered(f), `${f} is loaded by the extension but missing from the release zip`);
    }
  });

  it("does not ship tests or the workflow", () => {
    assert.ok(!covered("test/shared.test.js") && !covered(".github/workflows/release.yml") && !covered("package.json"));
  });
});

describe("popup layout guards", () => {
  const css = readFileSync(new URL("popup.css", root), "utf8");
  it("lets grid tracks shrink so a long URL cannot stretch the popup", () => {
    // Regression: without minmax(0, 1fr) a very long address made the popup content
    // thousands of pixels wide and the right edge (copy buttons) was clipped.
    assert.match(css, /main\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    assert.match(css, /\.recent-list\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });
});
