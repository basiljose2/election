## 1. Performance

- [ ] 1.1 k6 load scripts simulating 50 master/terminal pairs, 5 posts per ballot, 60 minutes; verify the report shows p95 < 1.5 s and a reconciliation PASS
- [ ] 1.2 Public-load mix (500 status board viewers) during the load test; verify cast latency is unaffected
- [ ] 1.3 Optional randomised batch storage behind a flag; verify the secrecy rank-correlation test improves and the load test still passes (or document the decision not to enable it)

## 2. Security

- [ ] 2.1 OWASP ASVS L2 checklist in `docs/security/asvs.md`; verify there are no open high items
- [ ] 2.2 Dependency audit in CI (npm audit / osv-scanner) failing on high or critical; verify CI blocks a known-vulnerable fixture
- [ ] 2.3 Penetration test script replaying every spec negative test against the deployed preview; verify all are rejected

## 3. Recoverability and monitoring

- [ ] 3.1 Enable Supabase PITR and document the restore procedure; verify a restore drill with verifier PASS on the restored data
- [ ] 3.2 Sentry with scrubbing, log drain scrubbing, uptime check and email alerts; verify a forced error alert contains no choice data

## 4. Operations

- [ ] 4.1 Kiosk configuration guide (Windows, Android, Chrome flags); verify by following it on one real device of each type
- [ ] 4.2 Pre-poll checklist, polling-day incident runbook and post-poll archiving procedure in `docs/runbooks/`; verify each incident procedure in the rehearsal
- [ ] 4.3 Dress rehearsal election (≥ 3 booths, multi-seat, booth-specific post, NOTA) on production; verify the verifier PASS and expected counts
