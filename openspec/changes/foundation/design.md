## Context

The repository is new. The target platform is Vercel (serverless functions), so there
are no persistent server processes or WebSockets. Real-time needs a managed service
(see `realtime-device-pairing`). Supabase Postgres supplies the transactional and
enforcement guarantees everything else relies on.

## Goals / Non-Goals

**Goals:**
- One mutation path for the whole app
- Immutability enforced by the database, not by application discipline
- An audit chain anyone can verify offline

**Non-Goals:**
- Device identity
- UI beyond sign-in, MFA and a minimal Super Admin shell

## Decisions

- **Mutation gateway ("commands").** Every write follows the same steps:
  authenticate → authorize (role + scope) → validate lifecycle → execute in one DB
  transaction → append Audit Event → commit.
  - Alternative considered: direct Supabase client writes guarded by RLS. Rejected
    because lifecycle and secrecy rules are error-prone to express in RLS alone.
  - Commands run on the server as Next.js server actions or route handlers, and
    connect to Postgres directly (pooled connection string) so they can use real
    transactions.
- **Database roles.**
  - `app_server`: used by server code. It has INSERT/SELECT on append-only tables and
    no UPDATE/DELETE/TRUNCATE on them.
  - `app_migrator`: used only by migrations in CI.
  - `anon` / `authenticated` (Supabase built-ins): no write grants anywhere; SELECT
    only on explicitly public views added by later changes.
  - Deny-by-default RLS on every table.
- **Audit chain.**
  - `hash = SHA-256(prev_hash || canonical_json(event_without_hash))`
  - The sequence number is allocated under a per-election transaction-scoped advisory
    lock, which gives no gaps and no forks.
  - Canonical JSON: sorted keys, UTF-8, no insignificant whitespace, ISO-8601 UTC
    timestamps.
- **Auth.**
  - Supabase Auth (email + password) with TOTP MFA; `aal2` is checked server-side
    for Super Admin and Returning Officer.
  - A `staff_roles` table holds (user, role, election_id?, booth_id?), with CHECK
    constraints enforcing the scope rules.
- **Security headers.** Strict nonce-based CSP, HSTS, `frame-ancestors 'none'`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy` minimal.
- **Rate limiting.** A sliding-window table in Postgres avoids adding another
  dependency. Upstash Redis is an optional upgrade in `hardening`.

## Secrecy and integrity

This change does not store votes. It establishes the append-only enforcement pattern
and the "no choice data in audit" rule that `ballot-casting-core` builds on.

## Risks / Trade-offs

- [The advisory lock serialises audit writes per election] → Campus-scale volume is small. Measure it in `hardening`.
- [The Supabase project owner and the service key can bypass grants] → Keep owner credentials with the Super Admin only; server code uses `app_server`, never the service key, for writes. The hash chain makes owner tampering detectable.
- [Serverless cold starts slow the first request] → Acceptable for staff UIs. Keep the terminal bundles small.

## Migration Plan

This is a greenfield project. Migrations run through Supabase CLI in CI; applying them
to production needs a manual approval step.
