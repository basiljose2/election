# Monitoring and alerting (without vote data)

## What the application provides

| Piece               | Where                               | Behaviour                                                                                                                                                                                                     |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uptime endpoint     | `GET /api/health`                   | `200 {"status":"ok"}` when the database answers, `503` otherwise; no versions or configuration; never cached                                                                                                  |
| Request error hook  | `src/instrumentation.ts`            | every unhandled server error is logged as `request.error` with the route and a digest code only, through the allowlisting logger (`src/lib/log.ts`)                                                           |
| Scrubbing           | `src/lib/monitoring/scrub.ts`       | `scrubEvent` for an error tracker's `beforeSend`: drops request bodies, cookies, users, choice and credential keys at any depth; masks ids and long tokens in text; keeps route, method, booth and error code |
| Casting log hygiene | `src/lib/log.ts`, `no-console` lint | only allowlisted, primitive, short fields can be written                                                                                                                                                      |
| Audit signals       | audit log                           | `terminal.went_offline`, reconciliation outcomes, denials and sign-in failures are Audit Events (no choices)                                                                                                  |

## What has to be configured on the deployment (not provable from the repository)

1. **Error tracker (Sentry or equivalent).** Initialise it server-side with
   `beforeSend: scrubEvent`, `sendDefaultPii: false`, request-body capture off. Add an alert
   rule for new issues and for any error on routes beginning `/terminal/api/cast`.
2. **Log drain.** Send Vercel logs to the sink with the scrub filter on; the application
   already writes only allowlisted fields, so the drain must not add request bodies.
3. **Uptime check** on `/api/health` every minute from outside the platform, alerting by
   email to the Super Admin after two consecutive failures.
4. **Alerts to the Super Admin** (email): server errors, database errors, failed
   reconciliation (Audit Events of type `election.reconciled` with a failed check) and
   terminal-offline events during polling hours.

## Verification

- Unit: `src/lib/monitoring/scrub.test.ts` forces a cast error event carrying a candidate id,
  cast token, cookie and user, and asserts none survives scrubbing.
- Drill (do once on the deployment, record the date): trigger a controlled server error on a
  cast route in the preview deployment, confirm an alert arrives, and confirm by reading the
  alert that it holds the route, booth and error code but no ids of candidates, no tokens and
  no request body.
