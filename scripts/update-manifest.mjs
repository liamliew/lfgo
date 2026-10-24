// Chrome's update manifest ("gupdate" XML), which managed browsers poll to install and update.
//   node scripts/update-manifest.mjs <id> <version> <crx-url>
export function updateManifest(id, version, crxUrl) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${esc(id)}">
    <updatecheck codebase="${esc(crxUrl)}" version="${esc(version)}" />
  </app>
</gupdate>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, version, url] = process.argv.slice(2);
  if (!id || !version || !url) throw new Error("usage: update-manifest.mjs <id> <version> <crx-url>");
  process.stdout.write(updateManifest(id, version, url));
}
