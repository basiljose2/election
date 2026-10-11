# OWASP ASVS Level 2 checklist

Status of each control for this application, with the evidence that backs it. This is a
working document for the release gate: **a real election needs every item below to be `Met`
or an accepted `N/A`, and every `Check on deployment` item ticked on the production
deployment.** Severity is the impact if the control failed.

Legend: **Met** (implemented and tested in this repository) · **Check on deployment**
(depends on the Vercel / Supabase configuration, so it cannot be proven from the code) ·
**N/A** (the feature does not exist).

Last reviewed against commit: _fill in at release_. Reviewer: _fill in_.

## V1 Architecture, design and threat modelling

| ID  | Control                                                                                                            | Severity | Status | Evidence                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1 | Documented architecture rules (server-side mutations only, signals are hints, secrets server-only)                 | High     | Met    | `openspec/project` context, `AGENTS.md`; enforced by `tests/integration/client-import.test.ts` (no server-only code in client bundles) |
| 1.4 | Trusted enforcement points: every mutation passes one gateway (authenticate, authorize, re-auth, lifecycle, audit) | High     | Met    | `src/lib/commands/gateway.ts`, `tests/integration/gateway.test.ts`                                                                     |
| 1.8 | Data classification: choices are the only secret data; they never reach audit, log or monitoring                   | High     | Met    | `src/lib/audit/chain.ts` forbidden keys, `src/lib/log.ts` allowlist, `src/lib/monitoring/scrub.ts`, tests for each                     |

## V2 Authentication

| ID   | Control                                                                                | Severity | Status              | Evidence                                                                                          |
| ---- | -------------------------------------------------------------------------------------- | -------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| 2.1  | Password policy (length), no composition rules, no truncation                          | Medium   | Met                 | staff creation requires 12+ characters (`src/app/admin/staff`)                                    |
| 2.2  | Rate limiting and lockout on sign-in                                                   | High     | Met                 | `src/lib/auth/signin.ts` (5 failures / 15 min), `tests/integration/signin-throttle.test.ts`       |
| 2.8  | TOTP MFA for privileged roles; re-authentication within 5 minutes for critical actions | High     | Met                 | `src/lib/auth/session-policy.ts`, `tests/e2e/mfa.spec.ts`, lifecycle re-auth tests                |
| 2.10 | No default or shared credentials; service secrets are not in the repository            | High     | Check on deployment | secrets only as Vercel env vars (`docs/ENVIRONMENTS.md`); run `git log -p` secret scan at release |

## V3 Session management

| ID  | Control                                                                                                    | Severity | Status | Evidence                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------- |
| 3.2 | Sessions are server-validated on every request; idle timeout (30 min staff, 12 h Master Terminal)          | High     | Met    | `src/lib/auth/resolve-actor.ts`, `tests/integration/session.test.ts`            |
| 3.4 | Cookies are `HttpOnly`, `Secure`, `SameSite`                                                               | High     | Met    | `src/lib/auth/cookies.ts`; device cookies in `src/lib/terminals/credentials.ts` |
| 3.7 | Device credentials are scoped by path and type (a Voting Terminal credential never works on master routes) | High     | Met    | `tests/e2e/terminal-pairing.spec.ts`, `scripts/pentest/run.mjs`                 |

## V4 Access control

| ID  | Control                                                                                                   | Severity | Status | Evidence                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------- | -------- | ------ | ---------------------------------------------------------------------------------------------------- |
| 4.1 | Deny by default; role and scope checked server-side on every command and page                             | High     | Met    | `defineCommand.authorize`, `tests/integration/gateway.test.ts`, `scripts/pentest/run.mjs`            |
| 4.2 | Object-level authorization: a Presiding Officer only touches their booth; an Observer only their election | High     | Met    | `boothGrant`, `electionGrant`; negative tests in lifecycle, results and transparency specs           |
| 4.3 | Database enforces the same boundaries (RLS, grants, append-only triggers), independent of the app         | High     | Met    | `supabase/tests/*.sql` (597+ assertions), baseline test denies every write to `anon`/`authenticated` |
| 4.4 | Votes cannot be read by the application role                                                              | High     | Met    | `supabase/tests/07_ballots.test.sql`; sealed `vote_reader` functions                                 |

## V5 Validation, sanitisation and encoding

| ID    | Control                                                                                     | Severity | Status | Evidence                                                                                        |
| ----- | ------------------------------------------------------------------------------------------- | -------- | ------ | ----------------------------------------------------------------------------------------------- |
| 5.1   | Input validated server-side (schemas, ballot rules, image content sniffing and re-encoding) | High     | Met    | zod command inputs, `src/lib/votes/validate.ts`, `src/lib/media/images.ts`                      |
| 5.3   | Output encoding / no raw HTML from user data; strict CSP with nonces                        | High     | Met    | React escaping, `src/lib/security/headers.ts`, `tests/e2e/security-headers.spec.ts`             |
| 5.3.4 | Parameterised queries only                                                                  | High     | Met    | all SQL uses `$n` parameters; the one dynamic fragment is a constant integer (`FEED_PAGE_SIZE`) |
| 5.5   | Untrusted files: images re-encoded, size limited                                            | Medium   | Met    | `src/lib/media/images.ts`                                                                       |

## V6 Stored cryptography

| ID  | Control                                                                                             | Severity | Status              | Evidence                                                                                        |
| --- | --------------------------------------------------------------------------------------------------- | -------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| 6.1 | Vote Selections, Booth Tallies and Results are signed (Ed25519), keys envelope-encrypted            | High     | Met                 | `src/lib/votes/keys.ts`, `signing.ts`, `tests/integration/booth-tally.test.ts`                  |
| 6.2 | Standard algorithms only (SHA-256, Ed25519, AES-256-GCM)                                            | High     | Met                 | `node:crypto`, pgsodium for in-database verification                                            |
| 6.4 | Master key management: `VOTE_SIGNING_MASTER_KEY` only in the server environment, rotation procedure | High     | Check on deployment | `docs/runbooks/pre-poll-checklist.md` (key generation step); confirm it is not in any log drain |

## V7 Error handling and logging

| ID  | Control                                                                                | Severity | Status              | Evidence                                                                                                   |
| --- | -------------------------------------------------------------------------------------- | -------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| 7.1 | No sensitive data in logs                                                              | High     | Met                 | allowlisting logger, `no-console` lint on casting code, `tests/integration/casting.test.ts` log-sink tests |
| 7.2 | Errors do not leak internals                                                           | Medium   | Met                 | `scripts/pentest/run.mjs` (`errors.no-stack`), command errors are caller-safe                              |
| 7.3 | Security events are audited (denials, sign-in failures, lockouts, terminal rejections) | High     | Met                 | `authz.denied`, `auth.*`, `terminal.rejected` events; tamper-evident hash chain, `tools/verifier`          |
| 7.4 | Monitoring and alerting without vote data                                              | High     | Check on deployment | scrubbing in `src/lib/monitoring/scrub.ts`; alert routing per `docs/readiness/monitoring.md`               |

## V8 Data protection

| ID  | Control                                                                                 | Severity | Status   | Evidence                                                                                                        |
| --- | --------------------------------------------------------------------------------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| 8.1 | Ballot secrecy: no link between a Vote Selection and a session, voter, terminal or time | High     | Met      | schema test in `07_ballots.test.sql`, `tests/integration/casting.test.ts` secrecy tests                         |
| 8.2 | Browser stores nothing about a ballot                                                   | High     | Met      | ESLint ban on web storage under `/terminal`, `tests/unit/no-terminal-storage-lint.test.ts`, e2e leftovers check |
| 8.3 | Public data is limited to explicit views                                                | High     | Met      | `public_*` views, `supabase/tests/08_public_views.test.sql`                                                     |
| 8.4 | Residual risk: physical row order of `vote_selections`                                  | Medium   | Accepted | `docs/readiness/batch-storage-decision.md`                                                                      |

## V9 Communications

| ID  | Control                                                    | Severity | Status                    | Evidence                                                                            |
| --- | ---------------------------------------------------------- | -------- | ------------------------- | ----------------------------------------------------------------------------------- |
| 9.1 | TLS everywhere; HSTS                                       | High     | Met / Check on deployment | HSTS header in `src/lib/security/headers.ts`; TLS terminated by Vercel and Supabase |
| 9.2 | Database connection uses TLS with certificate verification | High     | Met                       | `src/lib/db/supabase-ca.ts`, `sslmode=require`                                      |

## V10 Malicious code and V14 Configuration

| ID   | Control                                                                                  | Severity | Status | Evidence                                                                                    |
| ---- | ---------------------------------------------------------------------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------- |
| 10.3 | Dependencies audited; production dependencies have no high or critical advisory          | High     | Met    | `npm run check:audit` in CI (`scripts/check-audit.mjs`); dev-only advisories listed below   |
| 14.1 | Reproducible build, CI gates (lint, types, unit, integration, e2e, bundle budget, audit) | Medium   | Met    | `.github/workflows/ci.yml`                                                                  |
| 14.2 | Security headers on every response, including errors and rate-limit refusals             | Medium   | Met    | `scripts/pentest/run.mjs` header checks                                                     |
| 14.4 | Public endpoints rate limited; no write endpoints                                        | Medium   | Met    | `src/proxy.ts`, `tests/e2e/transparency.spec.ts`; Vercel Firewall rule: Check on deployment |
| 14.5 | Admin functions not exposed on public paths                                              | High     | Met    | route structure; pen-test script                                                            |

## Accepted risks and known advisories

- **Dev-only advisories** (`eslint-config-next` chain: `braces`, `micromatch`, `fast-glob`):
  tooling that never ships to a server or kiosk. The only upstream "fix" is a downgrade to a
  major version with other known issues, so it is tracked, not applied.
- **Small booths**: booth-wise figures can reveal how individuals voted. Runbook: use booths
  of at least ~25 voters, or accept disclosure for smaller ones.
- **Physical row order**: see `docs/readiness/batch-storage-decision.md`.

## Release gate

Before a real election, attach: this checklist with all `Check on deployment` items ticked,
the output of `npm run check:audit`, the output of `scripts/pentest/run.mjs` against the
deployed preview (all PASS), and the load-test and restore-drill reports.
