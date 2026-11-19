# ClassPulse 2.0

ClassPulse is a React + TypeScript academic platform for class scheduling, anti-proxy QR attendance, academic communication, consultations and digital excuse letters.

## Source

Complete source exported from an existing AppDeploy app. This repository is a development workspace. Changes here do **not** deploy or modify the hosted application.

## Backend

The API uses the `@appdeploy/sdk` runtime and needs AppDeploy-provisioned database, storage, authentication, notifications and WebSocket services. A standalone Vite build is not a functional substitute for deployment in that environment.

## Setup and security

Set `CLASSPULSE_ADMIN_EMAILS` to the initial administrator's verified email(s) in your *backend* environment. Never put real admin emails, credentials, or tokens in Git. Additional administrators can be invited through role-restricted account management.

## Attendance integrity

Keep the existing 12-hour offline QR synchronization rule, captured-at validity checks, and faculty review workflow intact.

## Development

See the `classpulse/ux-system-health` branch for non-deployed interface and administrator-health upgrades.
