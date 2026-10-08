## 1. Project scaffold

- [x] 1.1 Create the Next.js app (App Router, TypeScript strict) with Tailwind, ESLint and Prettier; verify `npm run build` and `npm run lint` pass
- [ ] 1.2 Add Vitest and Playwright with one smoke test each; verify both run in CI
- [x] 1.3 Set up Supabase CLI, the local stack and a migrations folder; verify `supabase db reset` succeeds locally
- [ ] 1.4 Configure Vercel env separation (local/preview/production) and a server-only env module that fails the build if imported by client code; verify with a test that a client import fails

## 2. Database roles and baseline security

- [x] 2.1 Migration: create `app_server` and `app_migrator` roles, revoke default privileges, enable deny-by-default RLS on all tables; verify an SQL test shows `anon`/`authenticated` cannot write to any table (negative test)
- [x] 2.2 Add security headers and nonce-based CSP middleware; verify in Playwright that the headers are present on every route

## 3. Authentication and roles

- [x] 3.1 Staff sign-in and sign-out with Supabase Auth and HttpOnly cookie sessions; verify with an e2e test
- [x] 3.2 TOTP MFA enrolment and challenge, enforcing aal2 for Super Admin and Returning Officer; verify an RO without completed MFA is denied (negative test)
- [x] 3.3 `staff_roles` table with scope CHECK constraints; verify an SQL test rejects a PO row without a booth_id and an RO row without an election_id
- [x] 3.4 Super Admin screens and commands to create/deactivate staff and assign roles; verify an RO calling them is rejected (negative test)
- [x] 3.5 Idle timeout (30 min staff, 12 h PO on Master Terminal); verify with a clock-mocked test
- [x] 3.6 Re-authentication guard for critical actions (5-minute window); verify a stale-auth request is rejected
- [x] 3.7 Sign-in rate limiting (5 failures per 15 min per account); verify the 6th attempt is blocked and audited

## 4. Mutation gateway and audit log

- [x] 4.1 `audit_events` table (election_id, seq, prev_hash, hash, payload) with grants and triggers blocking UPDATE/DELETE/TRUNCATE; verify SQL tests reject each operation (negative tests)
- [x] 4.2 Canonical JSON and hash-chain append under a per-election advisory lock; verify 50 parallel commands produce a gapless, valid chain
- [x] 4.3 Command gateway (authenticate → authorize → validate → transact → audit), rolling back on audit failure; verify with a test that injects an audit failure
- [x] 4.4 Audit denied-authorization attempts; verify a PO cross-booth attempt produces an Audit Event
- [x] 4.5 Audit export endpoint and a standalone verifier script (Node, no app imports); verify the verifier detects an altered, a removed and a reordered event
