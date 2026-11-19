# ClassPulse: Vercel + Supabase migration

ClassPulse's 61 existing API routes now import a Vercel-compatible backend adapter, and the React client uses Supabase Auth and Vercel Functions instead of AppDeploy. This preserves role rules, QR signatures, faculty review, and the 12-hour offline synchronization validation in backend/index.ts.

## Required setup

Vercel can build the frontend without secrets, but **sign-in and records will not work until Supabase is configured.** No sample student records are fabricated.

1. In Vercel project `classpulse-2-mobile`, connect or create a Supabase project using Storage / Marketplace. Your Vercel account already has the Supabase integration installed.
2. Open Supabase SQL Editor and execute `supabase/schema.sql` in full. It creates the private `cp_records` table, the atomic conditional `cp_apply_batch` function and a private Storage bucket.
3. Add the values in `.env.example` to Vercel Settings > Environment Variables, using your real Supabase project values. Never expose `SUPABASE_SERVICE_ROLE_KEY` in client code or commit it to Git. It must be a server-only encrypted secret.
4. Configure Supabase Authentication's site URL and allowed redirects to the Vercel domain. Enable Email OTP (magic link); Google and Apple require separate OAuth provider configuration.
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
