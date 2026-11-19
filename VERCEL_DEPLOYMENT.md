# ClassPulse: Vercel + Supabase migration

ClassPulse's 61 existing API routes now import a Vercel-compatible backend adapter, and the React client uses Supabase Auth and Vercel Functions instead of AppDeploy. This preserves role rules, QR signatures, faculty review, and the 12-hour offline synchronization validation in backend/index.ts.

## Required setup

Vercel can build the frontend without secrets, but **sign-in and records will not work until Supabase is configured.** No sample student records are fabricated.

1. In Vercel project `classpulse-2-mobile`, connect or create a Supabase project using Storage / Marketplace. Your Vercel account already has the Supabase integration installed.
2. Open Supabase SQL Editor and execute `supabase/schema.sql` in full. It creates the private `cp_records` table, the atomic conditional `cp_apply_batch` function and a private Storage bucket.
3. Add the values in `.env.example` to Vercel Settings > Environment Variables, using your real Supabase project values. Never expose `SUPABASE_SERVICE_ROLE_KEY` in client code or commit it to Git. It must be a server-only encrypted secret.
4. Configure Supabase Authentication's site URL and allowed redirects to Vercel, and enable email confirmation with password sign-in. Google and Apple require separate OAuth provider credentials.
5. Set `CLASSPULSE_ADMIN_EMAILS` securely in Vercel to the initial administrator's verified email. Do not put the address in the public Git repository.
6. Redeploy, check `/api/_healthcheck`, register a test account and verify all Student/Faculty/Admin routes and workflows before production.

## Important data limitation

**Existing AppDeploy student accounts, enrollments, attendance and photos are not automatically transferred.** Supabase begins with an empty database. Exporting and migrating actual user data requires authorized access and privacy review. The AppDeploy site can remain as a fallback until migration is verified.

## Security and features

- Supabase authenticated JWTs are verified on the Vercel server before using existing per-role permissions.
- Private Supabase Postgres `cp_records` uses RLS, and the service-only `cp_apply_batch` function performs multi-record conditional writes atomically with advisory locks.
- Profile photos and excuse documents go into private Supabase Storage. The server issues short-lived signed URLs.
- In-app notifications are persisted; external Web Push is **not configured** and is not claimed as working.
- Faculty status uses a 30-second foreground poll rather than WebSocket push.
- QR attendance remains server-validated, signed, faculty-approved, and constrained by the existing 12-hour offline grace period.

## Build

`npm install` then `npm run build`. Source-level checks are available through `npm run verify:source`; manual security and live-device QA remain essential.

Do not deploy this as the university production attendance system without verifying the new database, offline QR integrity, account migration and private documents.


## Email/password account creation and verification links

The signup page uses **Supabase Auth** (not a ClassPulse password table): `signUp({email,password,options:{emailRedirectTo}})`, `signInWithPassword`, confirmation resending, `resetPasswordForEmail`, and verified password recovery via `updateUser`.

**Configure Auth URL settings in the Supabase dashboard** at
`https://supabase.com/dashboard/project/zuhqscwgnrypgwytgxmq/auth/url-configuration`:

- Set **Site URL** to the stable ClassPulse Vercel domain:
  `https://classpulse-2-mobile-max0152003s-projects.vercel.app`
- Add the stable domain to allowed Redirect URLs:
  `https://classpulse-2-mobile-max0152003s-projects.vercel.app/**`
- Add the specific preview branch domain (for this development branch):
  `https://classpulse-2-mobile-git-classpulse-ebf014-max0152003s-projects.vercel.app/**`
- If using deploy-per-commit preview URLs, add the Vercel project preview wildcard cautiously:
  `https://*-max0152003s-projects.vercel.app/**`
- Add `http://localhost:5173/**` only for local development. Avoid wildcard redirects beyond the domains you control.

The app passes `?auth=confirmed` or `?auth=reset` to Supabase as the redirect destination, and handles callback errors, expired links and recovery mode after return. Use Supabase's default `{{ .ConfirmationURL }}` in confirmation templates, or make sure custom email templates use `{{ .RedirectTo }}` rather than hardcoded localhost or `{{ .SiteURL }}`.

**Enable Confirm email** in Supabase Authentication > Providers > Email. Do not turn email verification off to make testing easier. Supabase's default email service is limited; configure your own SMTP provider before institutional use. Ensure the app's Vercel deployment protection settings allow invited students to open confirmation links (Vercel's SSO protection can block them before Supabase Auth starts).

**Important:** Vercel still requires a server-only `SUPABASE_SERVICE_ROLE_KEY` before registration can complete the ClassPulse profile, and `CLASSPULSE_ADMIN_EMAILS` for the first administrator. Never expose either secret as a Vite variable or paste it into a chat.

## Fixing expired recovery links caused by email link previews

The recovery flow now supports a **two-stage, user-confirmed link**. Supabase's default `{{ .ConfirmationURL }}` goes to `/auth/v1/verify` immediately; Gmail/antivirus link scanners can consume its one-time token **before the student clicks it**. The ClassPulse app now accepts a recovery `token_hash` in its URL, holds it only in memory, removes it from the address bar, and does NOT verify it until the actual user selects **Continue securely**. If verification succeeds, the password update screen appears. Standard Supabase callback sessions still work via `PASSWORD_RECOVERY` event and `getUser()`.

**Manual Supabase dashboard step (required):** go to Authentication → Email Templates → **Reset password** in the ClassPulse 2.0 project. Replace only the Reset password email body with the following HTML, then Save:

```html
<h2>Reset your ClassPulse password</h2>
<p>We received a request to reset your password.</p>
<p>Open ClassPulse below, then select <strong>Continue securely</strong>
to verify this request and choose a new password.</p>
<p><a href="{{ .RedirectTo }}&amp;token_hash={{ .TokenHash }}&amp;type=recovery">
Continue to ClassPulse password reset
</a></p>
<p>If you did not request a reset, ignore this email.</p>
```

**Do not** use `{{ .ConfirmationURL }}` for the Reset password link in this configuration: it verifies immediately, which is susceptible to prefetching. Do not include actual passwords or API keys in email templates. Ensure Supabase Authentication URL Configuration includes the deployed Vercel origin and wildcard redirect for `/?auth=reset`. Disable click tracking/link wrapping in any email provider. This recovery-template change must be saved in Supabase; committing application code alone does not alter it. Links from emails sent **before** this change remain single-use and will not gain the new verification page.

**Manual verification:** request one fresh password reset email, click its newly formatted link, confirm the user sees **Continue securely**, click it once, set a strong password, and sign in with the updated password. Check Supabase Auth logs for a successful recovery `verifyOtp` and password update. For expired/consumed tokens the app offers to request another reset. Do not work around the error by disabling email verification.

## Troubleshooting login: invalid API response / ERR_MODULE_NOT_FOUND

In the Vercel preview, a successful Supabase Auth login is followed by `GET /api/bootstrap`. Runtime logs previously showed `ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/backend/index'` from `api/[...path].js`. This was an ESM import bug: Vercel's Node runtime preserves relative import specifiers but requires a `.js` extension. The code now uses `../backend/index.js` and `./vercel-sdk.js`. Source checks assert both routes and the browser reports actionable HTTP status when Vercel returns HTML.

**Important:** The preview Vercel environment currently lacks `SUPABASE_SERVICE_ROLE_KEY`, even though production has it. With missing credentials, the backend should now return a JSON `503` error rather than a cryptic HTML runtime error. To enable the full application, configure `SUPABASE_SERVICE_ROLE_KEY` in Vercel Preview scoped **only** to Git branch `classpulse/ux-system-health`, mark it sensitive/encrypted and redeploy. Do not paste the key into source, frontend `VITE_*` variables, logs or conversation. Do not simply expand the production key to all preview branches; isolate access to the intended branch. Also configure `CLASSPULSE_ADMIN_EMAILS` server-side only if a verified initial administrator is needed.

Verify the deployed function using an authenticated access path (Vercel CLI `vc curl` or Vercel Trusted Sources), or by signing into the stable branch preview and checking Vercel Runtime Logs for `GET /api/bootstrap`: first confirm `ERR_MODULE_NOT_FOUND` disappears, then check response status and API data, without logging JWTs. The Vercel build alone does not establish runtime correctness.


## Fix for nested API 404 on Vite Preview (2026-11-20)

The former `api/[...path].ts` appeared to work on one-segment paths (`/api/dashboard`, `/api/live`) but Vercel's standalone Node Functions do not implement Next.js's arbitrary-depth catch-all route syntax. Deep routes such as `/api/admin/users` returned a Vercel HTML 404, leading to the frontend message "ClassPulse API endpoint is missing from this deployment."

Use a real `api/index.ts` entry point and configure `vercel.json` `rewrites` with `/api/:path*` → `/api/index?cp_route=:path*`. The backend router reconstructs the original pathname from `req.query.cp_route` before matching methods/paths, preserving Supabase JWT validation, role checks, request bodies, path params, API JSON errors, and no-store headers. The old `api/[...path].ts` must be deleted so it does not compete.

Source verification now asserts this routing contract. To smoke test a new Preview build without revealing credentials, request `/api/_healthcheck` (expected JSON `{"ok":true,"service":"ClassPulse API"}`), then check unauthenticated `/api/admin/users` returns JSON 401 instead of HTML 404 and authenticated dashboard/admin nested routes work. Vercel Deployment Protection can prevent unauthenticated external probes: use an authorized Preview session, and verify requests in Vercel Runtime Logs. Production is intentionally unchanged.
