import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { extensionId } from "../scripts/extension-id.mjs";
import { updateManifest } from "../scripts/update-manifest.mjs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

describe("managed install helpers", () => {
  it("derives the id the Worker and Supabase are configured with from the manifest key", () => {
    assert.equal(extensionId(manifest.key), "bfdicajogngofgmdnilbhmpliocicbpi");
  });

  it("writes an update manifest Chrome understands", () => {
    const xml = updateManifest("bfdicajogngofgmdnilbhmpliocicbpi", "0.5.0", "https://example.test/a.crx?x=1&y=2");
    assert.match(xml, /<gupdate xmlns="http:\/\/www\.google\.com\/update2\/response" protocol="2\.0">/);
    assert.match(xml, /<app appid="bfdicajogngofgmdnilbhmpliocicbpi">/);
    assert.match(xml, /codebase="https:\/\/example\.test\/a\.crx\?x=1&amp;y=2" version="0\.5\.0"/);
  });

  it("never lets the private key into the repository", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    assert.match(workflow, /secrets\.EXT_PRIVATE_KEY/);
    assert.doesNotMatch(workflow, /BEGIN (RSA )?PRIVATE KEY/);
  });
});
