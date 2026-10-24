# LF ID: Google sign-in setup (using the LF Creative project)

People sign in with their `@lfcrea.com` Google account instead of sharing an API key.
"LF ID" is the **LF Creative** Supabase project (`vxgtywdqijtfnkgyubkh`, region
ap-southeast-2), which already has Google sign-in set up. The Worker only verifies the
tokens it issues (see "Google sign-in (LF ID)" in the README).

## What is already done

- The Worker (`wrangler.jsonc`) points at the project: `SUPABASE_URL` and
  `SUPABASE_PUBLISHABLE_KEY` (both public values).
- The extension (`config.js` on branch `claude/links-extension`) has the same two values.
- The Worker accepts both ways Supabase can sign tokens (public-key ES256/RS256, or the
  legacy shared-secret HS256 checked via the Auth server), so nothing about the project's
  signing keys needs to change.

## What you do (one step)

In the Supabase dashboard for **LF Creative**: **Authentication -> URL Configuration ->
Redirect URLs -> Add URL**:

```
https://bfdicajogngofgmdnilbhmpliocicbpi.chromiumapp.org/
```

That is the extension's sign-in return address (also shown on the extension's Settings
page, under "Server setup"; its id is fixed by the `key` in its manifest). Without it
Supabase refuses to send the browser back to the extension.

## How the domain is enforced

Because LF Creative is a live app that also has non-`lfcrea.com` users, the project is
**not** restricted to one domain, and the "before user created" hook from the generic
guide is deliberately **not** used (it would block those users). Enforcement is:

1. **The extension** only accepts a session for an `@lfcrea.com` email.
2. **The Worker** rejects any token whose email is not exactly `@lfcrea.com`, or whose
   account is not a verified Google account. This is the real gate: a personal Gmail
   account can sign in to LF Creative but cannot use the link API.
3. *(Optional, in Google Cloud)* an OAuth consent screen set to **Internal** would also
   stop outside accounts at Google, but that would break LF Creative's non-Workspace
   users, so leave it as is.

## Side effects to know about

- **First sign-in creates an LF Creative account.** The first time someone signs in
  through LFC Tools, Supabase creates a user for them in LF Creative, exactly as if they
  had signed in to the LF Creative app. Anything that app does for new users (profile
  rows, access requests) applies.
- **Removing someone** from link access: delete or ban them in Authentication -> Users.
  Their current access token works until it expires (default 1 hour) but they cannot
  refresh it. Changing `ALLOWED_EMAIL_DOMAIN` or removing the account's `@lfcrea.com`
  address also cuts access.
- **Revocation is quicker for legacy-signed tokens:** the Worker re-asks the Auth server
  at least once a minute, so a deleted or banned user is cut off within about a minute.

## Check it

1. Install the new extension build, open Settings, click **Sign in with Google**, pick
   your `@lfcrea.com` account: it should say "Signed in as ...".
2. Click the extension icon on a page: a link is created, with no API key involved.
3. Sign in with a personal Gmail account: the extension refuses it ("Only @lfcrea.com
   accounts can sign in"), and the Worker would too.
4. Sign out in Settings; the popup asks you to sign in again.

## Heads-up about LF Creative itself (not changed)

Supabase's checker reports five tables in LF Creative with Row Level Security **off**
(`project_shares`, `drives`, `files`, `project_file_refs`, `nas_folders`). Anyone holding
that project's public (anon) key can read and change them. That is unrelated to link
sign-in and I have not changed anything, but it is worth fixing: enable RLS and add the
policies your app needs.

## If you ever want a dedicated project instead

Create a new Supabase project, enable Google, point `SUPABASE_URL` /
`SUPABASE_PUBLISHABLE_KEY` (Worker) and `config.js` (extension) at it, and add the
redirect URL above. A dedicated project can also use a "before user created" hook to
allow only `@lfcrea.com` sign-ups, because it has no other users to break:

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
    'error', jsonb_build_object('message', 'Only lfcrea.com accounts are allowed.', 'http_code', 403)
  );
end;
$$;

grant execute on function public.hook_restrict_signup_by_email_domain to supabase_auth_admin;
revoke execute on function public.hook_restrict_signup_by_email_domain from authenticated, anon, public;
```

Then enable it under Authentication -> Hooks -> Before User Created.
