# Vercel deployment readiness

This repository originated on AppDeploy. Its frontend directly imports `@appdeploy/client`, and the backend imports `@appdeploy/sdk`. Both are platform-injected AppDeploy runtime modules; they are **not listed in package.json** and are not portable Vercel dependencies.

The screenshots-driven responsive fixes in this development branch do not change the attendance, security, role or academic data logic.

For a **functioning Vercel-hosted ClassPulse**, migration needs:
- A replacement authenticated client, backend API, WebSocket/push service, storage and persisted database hosted on or reachable from Vercel.
- A secure migration of existing authenticated users and academic data, respecting institutional privacy and retaining attendance records.
- New server-side role authorization, signed rotating QR tokens, offline validation and faculty verification. Never convert these to client-only logic.
- End-to-end tests of student/faculty/admin workflows, upload, download, notifications, offline scanning, and anti-proxy checks.

Vercel may build an independent static front-end after removing the platform imports, but that **would not be the real ClassPulse app**. Do not present such a static build as functional or auto-promote it to production.

The pending platform migration is separate from the CSS/iOS corrections. The original AppDeploy host remains the functional deployment until migration is validated.
