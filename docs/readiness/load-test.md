# Load test

**Requirement:** 50 booths, one ballot every 10 s, 5 Posts per ballot, 60 minutes: p95 cast
latency under 1.5 s, every ballot stored exactly once, zero failed casts, reconciliation PASS.
With 500 public viewers polling at the same time, the same figures must hold.

## Tools

| Step                                                                    | Command                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Seed N booths x P Posts (really frozen, Polling Open, terminals paired) | `tsx --conditions=react-server scripts/load/seed.ts --booths 50 --posts 5 --out load.json`             |
| Drive the casting path and public viewers                               | `node scripts/load/run.mjs --config load.json --base <url> --duration 3600 --interval 10 --public 500` |
| Close booths, sign tallies, reconcile                                   | `tsx --conditions=react-server scripts/load/finish.ts load.json`                                       |
| Verify the declared election afterwards                                 | `scripts/ops/verify-restore.ts` (see `docs/runbooks/restore-drill.md`)                                 |

All three need `TEST_ADMIN_DATABASE_URL` pointing at the **test** database the deployment
under test uses. Never point them at the production election database.

The driver issues Ballot Sessions by writing them to the database (standing in for the
Presiding Officer pressing Ballot) and then makes the real HTTP calls of a Voting Terminal:
`GET /terminal/api/ballot`, `POST /terminal/api/cast` with an idempotency key and kiosk-style
retry. The reported latency is the cast call. Public viewers use distinct
`X-Forwarded-For` values so the per-client rate limit treats them as separate clients.

The report is written to `load-report.json`; the process exits non-zero unless p95 is under
the limit, no cast failed, stored rows equal casts x rows per ballot, and nothing is pending.

## Result of the local run (smoke, not the release evidence)

Run on one developer machine against a production build (`next start`) and the local Supabase
stack: **50 booths, one ballot / 10 s, 5 Posts (one 2-seat), 500 public viewers, 90 s.**

| Measure                               | Result                                |
| ------------------------------------- | ------------------------------------- |
| Ballots issued / cast / failed        | 450 / 450 / 0                         |
| Cast latency p50 / p95 / p99 / max    | 42 / 60 / 74 / 95 ms                  |
| Ballot fetch p95                      | 22 ms                                 |
| Public status requests / errors / p95 | 4,496 / 0 / 13 ms                     |
| Stored selection rows vs expected     | 2,700 / 2,700                         |
| Reconciliation (`finish.ts`)          | PASS: 50 booths, 5 Posts, 450 ballots |

**What this does and does not show.** It proves the tooling works end to end and that the
casting path has a lot of headroom locally. It is **not** the release evidence: it ran for
90 seconds instead of 60 minutes, with no network between the driver and the server, on a
single machine that also hosted the database. The 60-minute run against the production-like
Vercel + Supabase deployment (same tier) is still to be done and attached here.

## Release run record

| Date    | Deployment | Duration | p95 cast | Failed | Reconciliation | Report |
| ------- | ---------- | -------- | -------- | ------ | -------------- | ------ |
| _to do_ |            | 60 min   |          |        |                |        |
