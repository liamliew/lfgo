# LF ID: Google sign-in setup

One-time setup so people sign in with their `@lfcrea.com` Google account instead of
sharing an API key. "LF ID" is a dedicated Supabase project that only handles sign-in;
the Worker verifies the tokens it issues (see "Google sign-in (LF ID)" in the README).

Three layers each enforce the domain, so one mistake does not open the door:

1. **Google** (OAuth consent screen set to *Internal*): Google refuses accounts outside
   your Workspace organisation. This needs `lfcrea.com` to be a Google Workspace domain.
2. **Supabase** (the hook below): rejects any sign-up whose email is not `@lfcrea.com`.
3. **The Worker**: rejects tokens whose email is not `@lfcrea.com`, or whose account is
   not a verified Google account.

## 1. Create the Supabase project

Dashboard -> New project. Name it `LF ID`, pick the region closest to your team, set a
database password and keep it somewhere safe. Use a **separate project**: do not reuse
the WA CRM or LF Creative projects.

Then **Project Settings -> JWT Keys**: the project should use an **asymmetric** signing
key (ES256 or RS256). Check by opening
`https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`: it must list at least
one key. If it shows `{"keys":[]}`, use the "Migrate JWT secret" button on that page and
rotate to an asymmetric key (Supabase docs: Auth -> Signing keys). The Worker only
accepts asymmetric tokens.

## 2. Google Cloud: OAuth client

[console.cloud.google.com](https://console.cloud.google.com), signed in as a Workspace admin:

1. Create (or pick) a project.
2. **Google Auth Platform / OAuth consent screen**: user type **Internal**. App name
   `LFC Tools`. Scopes: `openid`, `email`, `profile` (the defaults).
3. **Credentials -> Create credentials -> OAuth client ID -> Web application.**
   Under **Authorized redirect URIs** add
   `https://<project-ref>.supabase.co/auth/v1/callback`.
4. Copy the **Client ID** and **Client secret**.

## 3. Turn on Google in Supabase

Dashboard -> **Authentication -> Sign In / Providers**:

- **Google**: enable, paste the Client ID and secret, save.
- **Email**: turn the provider **off**. Email + password sign-ups would otherwise be
  possible. (The Worker also refuses non-Google accounts, but there is no reason to
  leave this door open.)

Dashboard -> **Authentication -> URL Configuration -> Redirect URLs**: add

```
https://bfdicajogngofgmdnilbhmpliocicbpi.chromiumapp.org/
```

That is the extension's redirect address (it is also shown on the extension's Settings
page, under "Server setup"). The extension's id is fixed by the `key` in its manifest.

## 4. The domain hook (Supabase side)

Run this in the Supabase **SQL Editor**:

```sql
create or replace function public.hook_restrict_signup_by_email_domain(event jsonb)
returns jsonb
language plpgsql
as $$
declare
  email text := lower(coalesce(event->'user'->>'email', ''));
begin
  if email ~ '^[^@[:space:]]+@lfcrea\.com$' then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object(
      'message', 'Only lfcrea.com accounts are allowed.',
      'http_code', 403
    )
  );
end;
$$;

grant execute on function public.hook_restrict_signup_by_email_domain to supabase_auth_admin;
revoke execute on function public.hook_restrict_signup_by_email_domain from authenticated, anon, public;
```

Then **Authentication -> Hooks -> Before User Created**: choose *Postgres function*,
select `public.hook_restrict_signup_by_email_domain`, enable it. (Format per the
Supabase "Before User Created Hook" docs: `{}` allows, an `error` object with a 4xx
`http_code` blocks.)

## 5. Point the Worker and the extension at the project

1. `worker/wrangler.jsonc`: set `"SUPABASE_URL": "https://<project-ref>.supabase.co"`
   (a public value, not a secret), commit and push. Cloudflare redeploys. Until this is
   set, signed-in requests get `sign_in_disabled` and only the API key works.
2. Extension branch `claude/links-extension`, `config.js`: set `SUPABASE_URL` to the
   same URL and `SUPABASE_PUBLISHABLE_KEY` to the project's **publishable** key
   (Project Settings -> API Keys). Both are public. **Never** put the secret /
   service-role key in the extension. Bump `version` in `manifest.json` and push to
   publish a release.

## 6. Check it

1. Install the new extension build, open Settings, click **Sign in with Google**, pick
   your `@lfcrea.com` account: it should say "Signed in as ...".
2. Click the extension icon on a page: a link is created (no API key involved).
3. Try an account outside the domain (a personal Gmail): it must be refused, by Google
   if the consent screen is Internal, otherwise by the hook ("Only lfcrea.com accounts
   are allowed").
4. Sign out in Settings, then confirm the popup asks you to sign in again.

## Operating notes

- **Removing someone:** Supabase -> Authentication -> Users -> delete (or ban) the user.
  Their current access token keeps working until it expires (default 1 hour, Settings ->
  JWT Keys / Auth); they cannot refresh it.
- **Session length:** the extension refreshes tokens automatically, so people stay
  signed in until the refresh is rejected or they sign out.
- **Who created a link** is not recorded yet; the "Created by" column in the manage
  page fills in once the Worker starts storing the signed-in email.
- **The API key** keeps working as the admin / script route. Rotate it with
  `wrangler secret put API_KEY` if it ever leaks.
