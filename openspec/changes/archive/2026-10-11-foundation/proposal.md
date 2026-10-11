## Why

Every other capability depends on knowing who is acting, on what scope, and on an
immutable record of what they did. Without a trustworthy identity and audit base, the
election cannot be secure or transparent.

Depends on: none (first change).

## What Changes

- Set up the Next.js + TypeScript + Supabase project on Vercel, with environment separation (local, preview, production)
- Add staff authentication with mandatory TOTP MFA for Super Admin and Returning Officer
- Add role-based access control scoped to an Election (Returning Officer) or a Polling Booth (Presiding Officer), plus Observer
- Add an append-only, hash-chained Audit Event log that the database enforces
- Add a server-side mutation gateway: every write passes auth, scope, lifecycle and audit checks
- Add baseline security headers, CSP and sign-in rate limiting

## Capabilities

### New Capabilities
- `access-control`: staff identities, MFA, roles and election/booth-scoped authorization
- `audit-log`: an append-only, hash-chained, independently verifiable record of every state-changing action

### Modified Capabilities
- none

## Non-goals

- Voter identity or voter rolls (out of scope for the product)
- Terminal (device) identity, which belongs to `realtime-device-pairing`
- Public audit viewer UI, which belongs to `transparency-portal`

## Impact

- New repository scaffold, CI (lint, typecheck, tests), Supabase migrations
- Every later change must use the mutation gateway and the audit service
