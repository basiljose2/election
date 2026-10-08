## Context

The system is deployed on Vercel with Supabase. The main risks on polling day are
network and device failure, operator error, and load spikes when results are
published.

## Goals / Non-Goals

**Goals:**
- Evidence-based readiness: every claim is backed by a test report or a drill

**Non-Goals:**
- New product features

## Decisions

- **Load testing.** k6 scripts that drive the real command endpoints with simulated
  master/terminal pairs (issue → fetch → cast), run against a dedicated
  production-like Supabase project (same tier). Afterwards, run election
  reconciliation and the verifier on the load-test election.
- **Randomised batch storage (optional).** Selections are written to an unlogged
  holding table, then moved into `vote_selections` in random order when the booth
  closes, in the same transaction as the tally. This is enabled only if the load test
  shows no latency regression; otherwise the residual risk stays documented.
- **Kiosk guides.**
  - Windows: Assigned Access with Edge kiosk, or Chrome `--kiosk --noerrdialogs --disable-pinch --overscroll-history-navigation=0`.
  - Android: screen pinning and a kiosk browser.
  - All: disable sleep, disable notifications, wired power.
- **Monitoring.** Vercel log drains into a sink with scrubbing, plus Sentry with body
  scrubbing and a `beforeSend` filter, and an uptime check on `/api/health`. Alerts go
  by email to the Super Admin.
- **Runbooks.** Stored in `docs/runbooks/` as step-by-step checklists that officers
  can print.

## Secrecy and integrity

Monitoring and logs are scrubbed. Batch randomisation strengthens secrecy against
database-level observers.

## Risks / Trade-offs

- [Supabase plan limits (connections, realtime concurrency)] → Size them with the load test; upgrade the tier before the election if needed.
- [Operators skip the runbook] → A training session plus the dress rehearsal are release gates.
