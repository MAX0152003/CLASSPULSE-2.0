# ClassPulse 2.0 · Source-only UX and System Health Upgrade

**Development branch:** `classpulse/ux-system-health`
**Source baseline:** AppDeploy snapshot `1795081149811`
**Deployment status:** **NOT DEPLOYED**. The live AppDeploy project remains unchanged.

## Changes implemented
- Mobile navigation opens with a **leftward swipe from the right edge** and closes with a rightward swipe. Gestures are edge-scoped so weekly-class card swipes work independently.
- Landscape phones use a vertically scrollable, normal-width side menu with an invisible scrollbar and a compact five-option dock aligned on the **right**. Page width is responsive; no browser zoom manipulation is used.
- The floating dock provides raised/3D active-state transitions; panels, sidebar selections and notifications use subtle depth with reduced-motion support.
- The top bar labels the **Student**, **Faculty**, or **Administrator** dashboard based on the authenticated role.
- Sidebar navigation has separators between primary pages, updates and account settings.
- Tapping a notification opens its full message/date in an animated detail panel, with an optional related-page action.
- The campus ID still flips in 3D when tapped; redundant **Card front / Card details** controls are replaced with a brief instruction.
- Profile photo changes offer a square Canvas crop preview plus zoom and horizontal/vertical position controls. The saved JPEG is displayed on the campus card and the header profile chip.
- Digital Excuse letter paper and typography adapt to dark/light themes; overlapping decorative shapes are suppressed.
- The footer stays in normal document flow beneath page content.

## Administrator permissions
Administrators **cannot** create, edit, import, or assign academic courses, sections, rooms, attendance or other academic records through the removed admin APIs. Existing Faculty academic actions are preserved.

The administrator console now contains:
- verified-email **Student or Faculty invitations** (the recipient signs in using their identity provider),
- verified-email **additional administrator invitations**,
- Faculty role approvals, existing users and access audit,
- reported technical issues and a resolve action,
- system API responsiveness, incomplete profiles, sampled offline-sync delays and pending scan review counts.

**Important:** disconnected devices cannot report real-time availability. All sync and scan metrics are **stored-record samples**, not invented outage counts, system-crash telemetry or active-device tracking. No changes were made to the 12-hour offline QR validation or existing anti-proxy flow.

## Required secure configuration
- Set `CLASSPULSE_ADMIN_EMAILS` in the **backend host secret environment** before ever deploying. The initial administrator email must **not** be committed to public source.
- The app uses AppDeploy-managed Google, Apple and passwordless-email login; user invitations cannot create passwords or bypass verified sign-in.
- Retained institutional records and account deletion need institutional policy review.

## Checks / future work
- Run `npm install` and `npm run verify:source` to parse TypeScript/TSX source and test role-security and responsive invariants. GitHub Actions runs this workflow on branch pushes. This does **not** replace an AppDeploy SDK-aware full build.
- Before any production deployment, test on iPhone Safari, Android Chrome, tablet, Windows browsers and an AppDeploy-compatible staging runtime. Verify onboarding and invitations using test accounts, photo crop/upload, notification details, academic QR regression, and 12-hour offline flow.
- Confirm the administrator environment secret is present before release. Academic admin API removal is a breaking change compared with the live app and requires review.

## Delivery
GitHub stores the upgrade source. **No hosting deployment, backend data migration, or live app update was requested or performed.**
