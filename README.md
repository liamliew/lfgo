# LFC Tools (Chrome extension)

Click the toolbar icon on any web page: LFC Tools creates a short link for that
page (or reuses the one that already exists), shows it in an editable field,
generates a QR code for it, and copies the link. Open the management page to
see, search, edit and delete every link.

Manifest V3. Permissions: `activeTab`, `storage` and `identity` (Google sign-in);
no host permissions and no `clipboardWrite`. This branch holds only the extension; the
Worker it talks to lives on branch `claude/links-worker`.

## Easy install

1. Download the latest **lfc-tools-extension-x.y.z.zip** from the
   [Releases page](https://github.com/liamliew/lfgo/releases). (No release yet?
   Use [this branch as a zip](https://github.com/liamliew/lfgo/archive/refs/heads/claude/links-extension.zip),
   which unzips into a folder you can load the same way.)
2. Unzip it somewhere permanent.
3. Open `chrome://extensions`, switch on **Developer mode**, click **Load
   unpacked**, and pick the unzipped folder (the one containing `manifest.json`).
4. The settings page opens automatically. Click **Sign in with Google** and
   choose your `@lfcrea.com` account. (Until Google sign-in is switched on for
   your build, paste the **API key** instead, click **Save**, then **Test
   connection**.) The domain is already `go.lfcrea.com`.
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
- **Lock with a PIN:** protect the link with a 6-digit PIN you type or generate.
  Visitors then see a PIN page and only reach the destination after the right
  PIN. The PIN is shown once when you set it (with a "Copy link + PIN" button),
  because only a hash is stored and it can't be shown again. Change or remove
  it any time (removing asks for a second click).
- Browser pages (`chrome://`, the Web Store, extension pages) can't be
  shortened and show a message instead.

**Manage page** (the list icon in the popup, or "See all"; it lives at
`chrome-extension://bfdicajogngofgmdnilbhmpliocicbpi/manage.html`)
- Table of every link: short link, destination and title, created date, with
  copy, open, QR code, edit and delete on each row.
- Create links (with optional custom alias), edit alias / destination / title,
  and delete with a confirmation.
- PIN locks: set a PIN when creating a link, or lock / change / remove it from
  any row (padlock button). Locked links show a padlock; filter by "Locked with
  a PIN" or "Not locked".
- Search (press `/` to jump to it), sort (newest, oldest, alias), select several
  and delete them in one go, and export the list to CSV (with a `locked` column;
  PINs are never exported).
- A "Created by" column appears automatically once the server reports who made
  each link (planned with Google sign-in).

**Settings** (right-click the icon, then Options)
- Short domain and API key, with a connection test. The page also shows the
  extension's address to add to the Worker's `ALLOWED_ORIGINS`.

Fonts: Inter, bundled in `fonts/` (SIL Open Font License). QR codes: the `uqr`
encoder, bundled in `vendor/` (MIT).

## Google sign-in (LF ID)

Team members sign in with their `@lfcrea.com` Google account instead of sharing an
API key.

- **Where to sign in:** the popup's "Sign in with Google" button opens the settings
  tab and starts the flow there. It can't run inside the popup, because Chrome
  closes a popup as soon as another window (Google's) takes focus, which would abort
  the sign-in. The settings page shows who is signed in and has Sign out.
- **How it works:** the extension sends you to the "LF ID" Supabase project's Google
  login using PKCE (`chrome.identity.launchWebAuthFlow`), gets a session back, and
  sends its access token to the Worker (`Authorization: Bearer ...`). The Worker
  checks the token's signature and that the account is a verified Google account
  on `lfcrea.com`. Tokens are refreshed automatically; refreshes are serialised
  across the popup and manage page because refresh tokens are single use.
- **Storage:** the session lives in `chrome.storage.local`, not `storage.sync`.
- **API key:** still works. If you are signed in the session is used; signed out,
  the saved key is the fallback. Keep it for admin / scripts.
- **Setup:** it uses the LF Creative Supabase project (public URL and publishable key in
  `config.js`; a test makes sure no secret key can be committed there). One manual
  step: in that project, Authentication -> URL Configuration -> Redirect URLs, add the
  address shown on this extension's Settings page under "Server setup" (it is
  `https://bfdicajogngofgmdnilbhmpliocicbpi.chromiumapp.org/`). Details, side effects
  and the domain rules are in `worker/LF-ID-SETUP.md` on branch `claude/links-worker`.
- **Domain:** only `@lfcrea.com` Google accounts get in: the extension refuses others,
  and the Worker rejects them even if a token is presented.
- **Safari:** has no `chrome.identity`, so the Safari build signs in in a tab instead (see below).

## Install for the whole Google Workspace (free)

No Chrome Web Store account needed. The release workflow can sign the extension and publish
an update file; the Admin console then installs it for everyone and keeps it updated.
The extension keeps its current id, so the Worker and Supabase settings stay as they are.

One-time setup:
1. Add the signing key as a repository secret named **EXT_PRIVATE_KEY**: the full text of the
   `.pem` file for this extension (GitHub: Settings > Secrets and variables > Actions).
   Keep the file safe: whoever has it can publish updates as this extension. It is not in
   this repository.
2. Bump `version` in `manifest.json` and push. The release then also contains
   `lfc-tools-<version>.crx`, and `update/updates.xml` is updated on this branch.
3. Google Admin console > Devices > Chrome > Apps & extensions > Users & browsers > pick the
   organisational unit > **+** > *Add Chrome app or extension by ID* > *From a custom URL*:
   - Extension ID: `bfdicajogngofgmdnilbhmpliocicbpi`
   - URL: `https://raw.githubusercontent.com/liamliew/lfgo/claude/links-extension/update/updates.xml`
   - Installation policy: **Force install** (optionally pin to the toolbar).

Try it on a small test organisational unit first. Google's rules for installing extensions
from outside the Web Store differ by platform: on Windows and Mac the browser generally has
to be managed (for example enrolled in Chrome Browser Cloud Management, which is free), so
check the current Admin console help before rolling it out to everyone. Updates arrive
automatically after each version bump.

## Safari

Safari needs the extension wrapped in a small Mac app, which only Xcode on a Mac can build.
Everything else is prepared here:

1. **Get the Xcode project.** Either run `scripts/safari-convert.sh` on a Mac with Xcode
   (and Node), or open the **Safari build** workflow's latest run on GitHub (Actions tab)
   and download its artifact `lfc-tools-safari-xcode-project`.
2. Open `LFC Tools.xcodeproj` in Xcode, pick your team under *Signing & Capabilities*
   (a free Apple ID works for your own Mac), and press **Run**.
3. In Safari: **Settings > Extensions**, tick LFC Tools, and under *Permissions* choose
   **Always Allow on Every Website** (or at least for `go.lfcrea.com` and the sites you shorten).
   For an unsigned build also enable **Develop > Allow Unsigned Extensions** (it resets on
   every Safari restart).
4. One-time server step: add `https://go.lfcrea.com/auth/done` to the LF Creative
   Supabase project's Redirect URLs (see `worker/LF-ID-SETUP.md` on branch
   `claude/links-worker`), and deploy the Worker at or after the "/auth/done" change.

How the Safari build differs (`scripts/build-safari.mjs` produces it from this same code):
- **Sign-in runs in a tab** because Safari has no `identity` API (Apple: "initiate an OAuth
  flow in a new tab"). It returns to the Worker's static `/auth/done` page; a small content
  script (`auth-bridge.js`, Safari build only) reports that address to the extension and the
  tab closes. Same PKCE flow and domain checks as Chrome.
- **Host access to the short domain** instead of the Worker's `ALLOWED_ORIGINS` list,
  because a Safari extension's address is different on every install.
- No `key`, no `identity`, background declared as a non-persistent script.
- Safari asks permission per website, so on a site you have not allowed the popup says it
  can't read the page's address.

**Not verified yet:** the Safari build has not been run in Safari. It was written against
Apple's compatibility guide, and the tests cover the manifest, the file list and the tab
flow with a fake browser. Things to check first on a Mac: that sign-in completes and the tab
closes; that API calls to `go.lfcrea.com` work (if Safari still blocks them with CORS, say
so and the Worker will be given a rule for Safari extensions); the keyboard shortcut; and
that copying to the clipboard works from the popup.

Sharing it with the team needs the paid Apple Developer Program (TestFlight, the Mac App
Store, or a Developer ID signed and notarised app).

## PIN locks: what you need to know

- **Server setup:** locks need the Worker from branch `claude/links-worker` at
  or after the "PIN-locked links" change, plus a `PIN_SECRET` Worker secret (see
  the Worker README). Without it the extension shows "PIN locks are not set up on
  the server yet" and nothing breaks.
- **How strong it is:** the PIN is checked by the Worker, never in the browser.
  Wrong guesses are limited (5 per IP address per 15 minutes; 30 per link per
  hour), and only a salted, secret-keyed hash is stored. Six digits is still
  modest protection against someone patient with many IP addresses, so treat it
  as a gate against casual access, not as a way to hide secrets.
- **What it does not protect:** the destination itself (anyone who knows the
  long URL can open it directly, and whoever enters the PIN sees it in the
  redirect). Anyone with the API key can reset or remove a PIN.
- Renaming a locked link keeps its PIN.

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
  "optional link title" change; an older Worker simply ignores titles. PIN locks
  need the later "PIN-locked links" change (see above).
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
npm test    # validation, API client, sign-in (PKCE, refresh, sign-out), PIN helpers, list helpers, CSV, QR, manifest and release-zip checks
```

The whole UI was also driven in a real Chromium against a local Worker
(`wrangler dev`): settings, generating state, QR codes decoded back to the
short URL (popup canvas, PNG and SVG downloads, manage dialog), rename, taken
alias, reuse, recent links, unsupported pages, search, sort, create, edit,
single and bulk delete, CSV export, the no-key states, and PIN locks end to end
(locking, changing, removing, the visitor's PIN page and redirect, filters), and Google
sign-in against a local stand-in for Supabase Auth (PKCE verified, real signed tokens
checked by the real Worker, refresh, sign-out, rejected accounts). Google's own consent
screen cannot be automated, so that one step is tested by hand.
