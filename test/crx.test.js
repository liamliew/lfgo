import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { checkKey, checkUpdateUrl } from "../scripts/check-release.mjs";
import { extensionId } from "../scripts/extension-id.mjs";
import { toSafariManifest } from "../scripts/safari-manifest.mjs";
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
    const workflow = readFileSync(new URL("../.github/workflows/publish-crx.yml", import.meta.url), "utf8");
    assert.match(workflow, /secrets\.EXTENSION_PEM/);
    assert.doesNotMatch(workflow, /BEGIN (RSA )?PRIVATE KEY/);
  });
});

describe("publish-crx workflow", () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const workflow = read(".github/workflows/publish-crx.yml");
  const baseUrl = workflow.match(/^\s+BASE_URL:\s*(\S+)/m)?.[1];

  it("hosts update.xml where manifest.json's update_url says (the build check, run as a unit test too)", () => {
    assert.ok(baseUrl?.startsWith("https://"), "BASE_URL must be https");
    assert.equal(checkUpdateUrl(manifest, `${baseUrl}/update.xml`), null);
    assert.equal(manifest.update_url, `${baseUrl}/update.xml`);
  });

  it("runs on published releases and when called by the release workflow", () => {
    assert.match(workflow, /release:\s*\n\s+types:\s*\[published\]/);
    assert.match(workflow, /workflow_call:/);
    const release = read(".github/workflows/release.yml");
    assert.match(release, /uses: \.\/\.github\/workflows\/publish-crx\.yml/);
    assert.match(release, /secrets: inherit/);
  });

  it("fails the build on a missing or wrong update_url", () => {
    assert.match(checkUpdateUrl({}, "https://x.test/update.xml"), /no update_url/);
    assert.match(checkUpdateUrl({ update_url: "https://other.test/update.xml" }, "https://x.test/update.xml"), /hosted at/);
    assert.match(checkUpdateUrl({ update_url: "http://x.test/update.xml" }, "http://x.test/update.xml"), /HTTPS/);
    assert.match(workflow, /node scripts\/check-release\.mjs update-url/);
  });

  it("only signs with the key behind the extension's id", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    assert.equal(checkKey(pem, key), null);
    assert.match(checkKey(pem, manifest.key), /not the key behind/);
    assert.match(checkKey("not a key", key), /not a readable private key/);
  });

  it("serves the .crx as application/x-chrome-extension with nosniff detached", () => {
    const headers = read("pages/_headers");
    assert.match(headers, /\/\*\.crx\s*\n\s+Content-Type: application\/x-chrome-extension/);
    for (const block of headers.split(/\n\n/).filter((b) => /^\/(update\.xml|\*\.crx)/m.test(b))) {
      assert.match(block, /^\s+! X-Content-Type-Options\s*$/m);
      assert.doesNotMatch(block, /^\s+X-Content-Type-Options:/m);
    }
  });

  it("keeps update_url out of the Safari build", () => {
    assert.equal(toSafariManifest(manifest).update_url, undefined);
  });
});
