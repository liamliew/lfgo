# lfgo Chrome extension

Click the toolbar icon on any web page: the extension creates a short link for
that page (or reuses the one that already exists), shows it in an editable
field, and copies it. Edit the field and press Save to rename the link.

Manifest V3. Permissions: `activeTab` and `storage` only (no host
permissions, no `clipboardWrite`). This branch holds only the extension; the
Worker it talks to lives on branch `claude/links-worker`.

## Easy install

1. Download the latest **lfgo-extension-x.y.z.zip** from the
   [Releases page](https://github.com/liamliew/lfgo/releases). (No release yet?
   Use [this branch as a zip](https://github.com/liamliew/lfgo/archive/refs/heads/claude/links-extension.zip),
   which unzips into a folder you can load the same way.)
2. Unzip it somewhere permanent.
3. Open `chrome://extensions`, switch on **Developer mode**, click **Load
   unpacked**, and pick the unzipped folder (the one containing `manifest.json`).
4. The settings page opens automatically. Paste your **API key**, click
   **Save**, then **Test connection**. The domain is already `go.lfcrea.com`.
5. Pin the icon and click it on any page.

Chrome does not allow one-click installs of extensions from outside the Chrome
Web Store, so "Load unpacked" is the simplest route. The same steps work in
Edge and Brave. To update, replace the folder's files with the new zip's and
press the reload arrow on the extension's card.

## Using it

- Open any `http(s)` page and click the icon. The short link appears at the top
  and is copied if the browser allows it (the **Copy** button always works).
- To use a custom alias, type it (3-32 characters: a-z, 0-9, hyphens) and
  press **Save** or Enter. "That alias is already taken." means pick another.
- Opening the popup again on the same page shows the same link instead of
  creating a duplicate.
- Browser pages (`chrome://`, the Web Store, extension pages) can't be
  shortened and show a message instead.

## Publishing a release (maintainers)

Bump `version` in `manifest.json`, commit, then push a matching tag:

```sh
git tag extension-v0.1.0
git push origin extension-v0.1.0
```

The workflow in `.github/workflows/release.yml` checks the tag against the
manifest version, runs the tests, zips only the files the browser needs, and
creates the GitHub release with the zip attached.

## How it works / notes

- The popup reads the active tab's URL (allowed by `activeTab` because opening
  the popup is the action invocation), then calls the Worker:
  `GET /api/links?url=...` to find an existing link, otherwise
  `POST /api/links`; Save calls `PATCH /api/links/:code`.
- With no host permissions, the browser applies CORS to these requests. The
  Worker allows them for this extension's origin only, via `ALLOWED_ORIGINS`
  in the Worker branch's `wrangler.jsonc`. If you see "Could not reach ...",
  check that list.
- The extension has a fixed id, `bfdicajogngofgmdnilbhmpliocicbpi`, set by the
  `key` in `manifest.json` (a public key). Removing it changes the id and the
  allow-list would need updating (the id is shown on the Options page). The
  matching private key is not in this repository; it is only needed if you
  publish to the Chrome Web Store later.
- Settings are kept in `chrome.storage.local`, not `storage.sync`, so the API
  key is not copied to other browsers signed in to your Google account.
- Strict extension CSP: no inline scripts; everything is in separate files.

## Tests

```sh
npm test    # unit tests for validation, the API client and settings
```
