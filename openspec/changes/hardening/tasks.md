## 1. Performance

- [ ] 1.1 k6 load scripts simulating 50 master/terminal pairs, 5 posts per ballot, 60 minutes; verify the report shows p95 < 1.5 s and a reconciliation PASS — DONE: scripts/load/{seed,run,finish}; smoke 50 booths/90 s p95 60 ms, reconciliation PASS (docs/readiness/load-test.md). REMAINING: the 60-minute run on the production-like deployment.
- [ ] 1.2 Public-load mix (500 status board viewers) during the load test; verify cast latency is unaffected — DONE: --public viewers in the same run (500 viewers, 0 errors, cast p95 unchanged). REMAINING: repeat inside the 60-minute deployment run.
- [x] 1.3 Optional randomised batch storage behind a flag; verify the secrecy rank-correlation test improves and the load test still passes (or document the decision not to enable it) — DECIDED NOT TO ENABLE: docs/readiness/batch-storage-decision.md

## 2. Security

- [ ] 2.1 OWASP ASVS L2 checklist in `docs/security/asvs.md`; verify there are no open high items — DONE: docs/security/asvs.md. REMAINING: the "Check on deployment" items (V2.10, V6.4, V7.4, V9.1) must be ticked on the real deployment.
- [x] 2.2 Dependency audit in CI (npm audit / osv-scanner) failing on high or critical; verify CI blocks a known-vulnerable fixture — DONE: scripts/check-audit.mjs + tests/unit/audit-gate.test.ts + CI step; next 16.3.7 -> 16.4.0
- [ ] 2.3 Penetration test script replaying every spec negative test against the deployed preview; verify all are rejected — DONE: scripts/pentest/run.mjs, 52/52 PASS against a local production build. REMAINING: run it against the deployed preview.

## 3. Recoverability and monitoring

- [ ] 3.1 Enable Supabase PITR and document the restore procedure; verify a restore drill with verifier PASS on the restored data — DONE: scripts/ops/verify-restore.ts (PASS on a clean rehearsal election; correctly FAILS a drifted one) and docs/runbooks/restore-drill.md. REMAINING: enable PITR and perform the drill on Supabase.
- [ ] 3.2 Sentry with scrubbing, log drain scrubbing, uptime check and email alerts; verify a forced error alert contains no choice data — DONE: /api/health, src/instrumentation.ts, scrubEvent + tests, docs/readiness/monitoring.md. REMAINING: wire the error tracker, log drain, uptime check and email alerts; forced-error alert drill.

## 4. Operations

- [ ] 4.1 Kiosk configuration guide (Windows, Android, Chrome flags); verify by following it on one real device of each type — DONE: docs/runbooks/kiosk-configuration.md. REMAINING: follow it on one real device of each type.
- [ ] 4.2 Pre-poll checklist, polling-day incident runbook and post-poll archiving procedure in `docs/runbooks/`; verify each incident procedure in the rehearsal — DONE: pre-poll-checklist, polling-day-incidents, post-poll-archiving in docs/runbooks/. REMAINING: exercise each incident procedure in a rehearsal.
- [ ] 4.3 Dress rehearsal election (≥ 3 booths, multi-seat, booth-specific post, NOTA) on production; verify the verifier PASS and expected counts — DONE: scripted rehearsal tests/integration/rehearsal.test.ts (3 booths, 2-seat Post, booth-specific Post, NOTA; counts and verifier PASS) and docs/runbooks/dress-rehearsal.md. REMAINING: run it on the production deployment.
