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
