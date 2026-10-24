# lfgo Chrome extension

Click the toolbar icon on any web page: the extension creates a short link for
that page (or reuses the one that already exists), shows it in an editable
field, and copies it. Edit the field and press Save to rename the link.

Manifest V3. Permissions: `activeTab` and `storage` only (no host
permissions, no `clipboardWrite`).

## Install (load unpacked)

1. Make sure the Worker is deployed with this extension allowed. The extension
   has a fixed id, set by the `key` in `manifest.json`:
   `bfdicajogngofgmdnilbhmpliocicbpi`. `worker/wrangler.jsonc` already lists
   `chrome-extension://bfdicajogngofgmdnilbhmpliocicbpi` in `ALLOWED_ORIGINS`.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked** and choose this `extension` folder.
3. Pin the icon (puzzle-piece menu), then open **Options** (right-click the
   icon -> Options, or the link in the popup):
   - **Short domain**: `go.lfcrea.com`
   - **API key**: the value you stored with `wrangler secret put API_KEY`
   - Click **Save**, then **Test connection**. It should say "Connected".

## Using it

- Open any `http(s)` page and click the icon. The short link appears at the top
  and is copied if the browser allows it (the **Copy** button always works).
- To use a custom alias, type it (3-32 characters: a-z, 0-9, hyphens) and
  press **Save** or Enter. "That alias is already taken." means pick another.
- Opening the popup again on the same page shows the same link instead of
  creating a duplicate.
- Browser pages (`chrome://`, the Web Store, extension pages) can't be
  shortened and show a message instead.

## How it works / notes

- The popup reads the active tab's URL (allowed by `activeTab` because opening
  the popup is the action invocation), then calls the Worker:
  `GET /api/links?url=...` to find an existing link, otherwise
  `POST /api/links`; Save calls `PATCH /api/links/:code`.
- Because there are no host permissions, the browser applies CORS to these
  requests. The Worker allows them for the extension's origin only, via
  `ALLOWED_ORIGINS`. If you see "Could not reach ...", check that list.
- Settings are kept in `chrome.storage.local`, not `storage.sync`, so the API
  key is not copied to other browsers signed in to your Google account.
- Strict extension CSP: no inline scripts; everything is in separate files.

## Changing the extension id

The `key` in `manifest.json` is only a public key; it pins the id so the
Worker's allow-list stays valid. Removing it makes Chrome pick an id from the
folder path, and you'd need to update `ALLOWED_ORIGINS` (the id is shown on the
Options page). The matching private key is not needed for loading unpacked and
is not in this repository.

## Tests

```sh
npm test    # unit tests for validation, the API client and settings
```

The popup flow was also driven in a real Chromium against a local Worker
(`wrangler dev`): options, wrong/right key, create, rename, taken alias, reuse,
unsupported pages, and the no-key state.
