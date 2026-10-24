# LF GO (Chrome extension)

Click the toolbar icon on any web page: LF GO creates a short link for that
page (or reuses the one that already exists), shows it in an editable field,
generates a QR code for it, and copies the link. Open the management page to
see, search, edit and delete every link.

Manifest V3. Permissions: `activeTab` and `storage` only (no host
permissions, no `clipboardWrite`). This branch holds only the extension; the
Worker it talks to lives on branch `claude/links-worker`.

## Easy install

1. Download the latest **lf-go-extension-x.y.z.zip** from the
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

## What it does

**Popup** (click the icon, or press **Alt+Shift+L**; change the shortcut at
`chrome://extensions/shortcuts`)
- Creates the link for the current page, or reuses the existing one. While it
  is being created the link field reads "Generating…" and the rest of the
  popup stays in place.
- Edit the field to use a custom alias (3-32 characters: a-z, 0-9, hyphens) and
  press **Save** or Enter. "That alias is already taken." means pick another.
- Shows a **QR code** for the link straight away, with **PNG** (high
  resolution) and **SVG** (vector) download buttons.
- Copies the link automatically when it can; the copy button always works.
- Stores the page's title with the link so lists are readable.
- Lists your most recent links for one-click copying.
- Browser pages (`chrome://`, the Web Store, extension pages) can't be
  shortened and show a message instead.

**Manage page** (the list icon in the popup, or "See all"; it lives at
`chrome-extension://bfdicajogngofgmdnilbhmpliocicbpi/manage.html`)
- Table of every link: short link, destination and title, created date, with
  copy, open, QR code, edit and delete on each row.
- Create links (with optional custom alias), edit alias / destination / title,
  and delete with a confirmation.
- Search (press `/` to jump to it), sort (newest, oldest, alias), select several
  and delete them in one go, and export the list to CSV.
- A "Created by" column appears automatically once the server reports who made
  each link (planned with Google sign-in).

**Settings** (right-click the icon, then Options)
- Short domain and API key, with a connection test. The page also shows the
  extension's address to add to the Worker's `ALLOWED_ORIGINS`.

Fonts: Inter, bundled in `fonts/` (SIL Open Font License). QR codes: the `uqr`
encoder, bundled in `vendor/` (MIT).

## Publishing a release (maintainers)

Bump `version` in `manifest.json`, commit and push this branch. The workflow in
`.github/workflows/release.yml` sees that `extension-v<version>` has no release
yet, runs the tests, zips only the files the browser needs, and creates the
release (and its tag) with the zip attached. Pushes that don't change the
version do nothing. A test fails if the zip list ever misses a file the
extension loads.

## How it works / notes

- The popup reads the active tab's URL and title (allowed by `activeTab`
  because opening the popup is the action invocation), then calls the Worker:
  `GET /api/links?url=...` to find an existing link, otherwise
  `POST /api/links`; Save calls `PATCH /api/links/:code`. The manage page also
  uses `GET /api/links` (paged) and `DELETE /api/links/:code`.
- Page titles need the Worker from branch `claude/links-worker` at or after the
  "optional link title" change; an older Worker simply ignores titles.
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
- Strict extension CSP: no inline scripts and no remote resources; everything
  is bundled.
- The list is loaded in full (following the Worker's pagination), which is fine
  for hundreds or a few thousand links.

## Tests

```sh
npm test    # validation, API client, list helpers, CSV, QR, manifest and release-zip checks
```

The whole UI was also driven in a real Chromium against a local Worker
(`wrangler dev`): settings, generating state, QR codes decoded back to the
short URL (popup canvas, PNG and SVG downloads, manage dialog), rename, taken
alias, reuse, recent links, unsupported pages, search, sort, create, edit,
single and bulk delete, CSV export and the no-key states.
