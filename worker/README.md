# lfgo worker

Personal URL shortener: a Cloudflare Worker backed by Workers KV, served on
`go.lfcrea.com`.

| Route | Auth | What |
|---|---|---|
| `GET /:code` | public | 302 to the long URL, friendly 404 page if missing |
| `POST /api/links` | key | Create `{url, alias?}` -> `{code, shortUrl, url, createdAt, updatedAt}` (201) |
| `GET /api/links` | key | List, paginated: `?limit=` (default 100, max 500) `&cursor=` |
| `GET /api/links?url=<long url>` | key | Look up the link(s) for an exact destination (used by the extension to avoid duplicates) |
| `GET /api/links/:code` | key | One link |
| `PATCH /api/links/:code` | key | `{newCode?, url?}`: rename and/or change destination |
| `DELETE /api/links/:code` | key | Delete |

Auth: send the key as `X-API-Key: <key>` or `Authorization: Bearer <key>`.
Errors are `{"error": "...", "code": "..."}`; `code` is `alias_taken` (409),
`invalid_alias` (400), `not_found` (404), `unauthorized` (401).

Alias rules: lowercase `a-z`, `0-9` and hyphens, 3-32 characters, no leading,
trailing or doubled hyphens, and not a reserved word (`api`, `admin`, `www`,
`login`, ... see `src/validate.ts`). Input is lowercased, so `My-Docs` becomes
`my-docs`. Generated codes are 7 random characters. Destinations must be
absolute `http(s)` URLs up to 2048 characters, without credentials, and not on
the shortener's own host.

The redirect is a **302**, not a 301, so edits and deletes are not stuck in
browser caches.

## Deploy

Prerequisites: Node 20+, a Cloudflare account, and the `lfcrea.com` zone
active on that account.

```sh
cd worker
npm install
npx wrangler login
```

1. **KV namespace.** `wrangler.jsonc` binds `LINKS` without an id, so
   `wrangler deploy` provisions the namespace for you and writes the id back
   into the file; commit that change. To use an existing namespace instead,
   run `npx wrangler kv namespace create LINKS` and add `"id": "<id>"` to the
   binding.
2. **Deploy once, then set the API key secret.** Run `npx wrangler deploy`
   (step 5) first so the Worker exists, then generate a long random key and
   store it as a Worker secret (never in the repo):
   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   npx wrangler secret put API_KEY
   ```
   Keep a copy for wacrm (`LINKS_API_KEY`) and the extension's options page.
   Until the secret exists the Worker returns 500 for every `/api/*` call (it
   fails closed). The redirect route keeps working.
3. **Domain.** The `routes` entry in `wrangler.jsonc` attaches the Worker to
   `go.lfcrea.com` as a Custom Domain; Cloudflare creates the DNS record and
   certificate. This fails if `go` already has a CNAME record in the zone:
   delete it first. (Dashboard alternative: Workers & Pages -> lfgo ->
   Settings -> Domains & Routes -> Add -> Custom Domain.)
4. **CORS.** Set `ALLOWED_ORIGINS` in `wrangler.jsonc` to a comma-separated
   list of browser origins allowed to call `/api/*`, e.g. the extension as
   `chrome-extension://<extension-id>` (the id is shown on
   `chrome://extensions`). wacrm calls the API from its server, so it needs no
   entry. Requests from other origins get no CORS headers.
5. Deploy: `npx wrangler deploy`. Do this before step 2's `secret put` on a
   fresh setup, and again after changing `ALLOWED_ORIGINS`.

### Alternative: deploy from GitHub (Workers Builds)

Instead of running Wrangler yourself, connect this repo and Cloudflare deploys
on every push to the production branch.

1. Cloudflare dashboard -> **Workers & Pages** -> **Create application** ->
   **GitHub**; authorise the "Cloudflare Workers and Pages" app for this repo
   only, then pick `liamliew/lfgo`.
2. The Worker name must be **`lfgo`** (it must match `name` in
   `wrangler.jsonc`, or the build fails).
3. Build settings: **Root directory** `worker`; **Build command** empty;
   **Deploy command** `npx wrangler deploy` (the default). Set the production
   branch under Settings -> Build -> Branch control.
4. **Save and Deploy.** The KV namespace is created on the first deploy; with
   Git builds its id is only visible in the dashboard and is not written back
   to the repo, so leave `wrangler.jsonc` as is.
5. Add the secret under the Worker's **Settings -> Variables and Secrets**
   (type *Secret*, name `API_KEY`). Do not use *Build variables and secrets*:
   those are not available to the running Worker.
6. After that, changing `ALLOWED_ORIGINS` or any code is just a commit and
   push.

Pushes to other branches run a preview build (`wrangler preview`) with its own
settings; turn that off under Settings -> Build -> Branch control if you do not
want it.

Check it:

```sh
curl -i https://go.lfcrea.com/nope                      # friendly 404
curl -H "X-API-Key: $KEY" -H 'content-type: application/json' \
     -d '{"url":"https://example.com","alias":"test"}' \
     https://go.lfcrea.com/api/links
curl -i https://go.lfcrea.com/test                      # 302 to example.com
```

## Local development and tests

```sh
cp .dev.vars.example .dev.vars    # then set API_KEY (file is git-ignored)
npm run dev                       # wrangler dev; KV is simulated locally
npm test                          # unit + handler tests, no Cloudflare needed
npm run typecheck
```

## Limitations (read these)

- **KV is eventually consistent.** Per the
  [KV docs](https://developers.cloudflare.com/kv/concepts/how-kv-works/), a
  change is usually visible immediately where it was made but can take 60
  seconds or more to show elsewhere, and "key does not exist" answers are
  cached too. A brand-new link can 404 in another region for about a minute;
  an edited or deleted one can keep resolving to its old target for as long.
  The API list can briefly lag the same way.
- **No atomic operations, so the alias-taken check is not race-proof.** The
  Worker reads, then writes. Two simultaneous creates of the same alias can
  both pass the check, and the last write wins. Rename writes the new key
  first, then deletes the old one. This is acceptable for one person; it would
  not be for many concurrent writers.
- **Duplicate-URL lookup scans the namespace** (`GET /api/links?url=`). Fine
  for hundreds or a few thousand links.
- **No click counts.** Counters are deliberately not stored in KV. A later
  phase could add them with Durable Objects or Workers Analytics Engine.
- **Free-plan KV limits** (see KV limits docs): 1,000 writes/day, 100,000
  reads/day, 1 write per second to the same key. Each create is one write
  (plus reads for the checks); a rename is two writes.
- Link metadata is limited to 1,024 bytes, so URLs longer than about 700 bytes
  are not duplicated into it and the list endpoint reads those values
  individually. This is handled transparently.
- There is no rate limiting beyond Cloudflare's defaults; the API is protected
  only by the key.
