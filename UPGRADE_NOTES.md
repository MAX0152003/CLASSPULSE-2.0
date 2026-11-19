# ClassPulse 2.0 – Development Upgrade Notes

Source-only development branch `classpulse/ux-system-health`, based on exported AppDeploy source. The original AppDeploy deployment remains separate.

The branch adds administrator access management, account invitations, technical incident reports, campus ID image crop and header photo, notification detail view, tactile mobile navigation, and adapted digital excuse letters. Server administrator operations exclude academic section management. The existing QR attendance and offline capture workflow are unchanged.

## Mobile screen corrections (November 19, 2026)

The five screenshots reported: overlapping From/Until date selectors on Faculty Student Records, merged labels in the five-button bottom dock, toolbar/content moving under the iPhone status area, a tall blank weekly class-day card with duplicate heading, and a dock obscuring buttons and footer.

The latest patch makes faculty filters single-column below 700px; constrains native iOS date inputs, wraps dock labels into two lines, reserves bottom safe-area clearance after all content and footer, makes the toolbar sticky below the iPhone status area, and trims duplicate weekly headings and blank-card height. Landscape dock stays on the right.

Review on real iPhone, Android, tablet, and Windows; this source branch is not a verified production release.

## Vercel dependency blocker

`@appdeploy/client` and `@appdeploy/sdk` are runtime-injected dependencies of the original AppDeploy host. Vercel does not automatically provide those services. A working Vercel migration requires reimplementing server APIs, auth, database, storage, realtime, QR signing and offline scan verification before marking the app production ready. See `VERCEL_DEPLOYMENT.md`.

Set `CLASSPULSE_ADMIN_EMAILS` as a secure backend environment variable in any supported host.
