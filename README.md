# Campus EVM

An online election system for campus elections, modelled on Electronic Voting Machines.
Next.js (App Router) on Vercel, Supabase Postgres and Auth.

- Product rules and vocabulary: `openspec/config.yaml`
- Implementation plan: `docs/ROADMAP.md`
- Environments and secrets: `docs/ENVIRONMENTS.md`
- Audit export format and verifier: `docs/AUDIT_FORMAT.md`

## Getting started

```bash
npm ci
npx supabase start          # local Postgres + Auth, applies migrations and seed
cp .env.example .env.local  # fill the keys from `npx supabase status`
BOOTSTRAP_EMAIL=you@example.test BOOTSTRAP_NAME="You" BOOTSTRAP_PASSWORD='...' npm run bootstrap:admin
npm run dev
```

## Tests

| Command                                                       | What it runs                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `npm test`                                                    | Vitest unit tests                                                 |
| `npm run test:db`                                             | pgTAP tests for grants, triggers and RLS (`supabase/tests`)       |
| `npm run test:integration`                                    | Vitest against the local database (gateway, audit chain, sign-in) |
| `npm run test:e2e`                                            | Playwright against a production build                             |
| `npm run lint` / `npm run typecheck` / `npm run format:check` | Static checks                                                     |

## Architecture rules

- All mutations go through the command gateway (`src/lib/commands/gateway.ts`):
  authenticate → authorize (role + scope) → re-auth for critical actions → one transaction
  { validate → execute → append Audit Event }.
- Browsers never write to the database. Server code connects as `app_server`; `anon` and
  `authenticated` have no write privileges, and every table has deny-by-default RLS.
- Audit Events are append-only and hash-chained per Election.
