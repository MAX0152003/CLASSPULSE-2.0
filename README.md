# ClassPulse 2.0

An academic scheduling, anti-proxy dynamic QR attendance, excuse-letter, consultation and communication application for Mindanao State University – Main Campus.

## Vercel migration

This development branch uses **React/Vite, Vercel Functions, Supabase Auth, Supabase Postgres and private Supabase Storage**. The previous AppDeploy SDK imports have been removed.

**The Vercel project needs a Supabase connection and one SQL schema installation before users can sign in or use academic data.** No demo users or fabricated attendance are included. See [VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md) for setup, privacy and security requirements.

- Frontend: `src/App.tsx`, `src/lib/platform.ts`, `src/index.css`
- API routes: `api/[...path].ts`
- Academic, QR and authorization logic: `backend/index.ts`
- Vercel persistence adapter: `backend/vercel-sdk.ts`
- Database schema: `supabase/schema.sql`
- Regression checks: `npm run verify:source`

## Important

Existing AppDeploy account and attendance records **have not been migrated**. The new Supabase backend begins empty. Export and migrate institutional data only with authorization. The existing 12-hour offline QR synchronization rule and server-side verification are preserved. Browser Web Push is not configured; academic notices remain accessible inside ClassPulse. Do not treat a ready Vercel build alone as a verified production release.
