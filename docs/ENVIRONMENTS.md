# Environments

There are three environments. Each has its own Supabase project and its own secrets.

| Environment | Where it runs                              | Supabase project               | `VERCEL_ENV`           |
| ----------- | ------------------------------------------ | ------------------------------ | ---------------------- |
| local       | `npm run dev` / CI                         | local stack (`supabase start`) | unset or `development` |
| preview     | Vercel preview deployments (pull requests) | separate staging project       | `preview`              |
| production  | Vercel production deployment               | production project             | `production`           |

All variables are **server-only**. There are no `NEXT_PUBLIC_*` variables: browsers never
talk to Supabase directly. `src/lib/env/server.ts` validates them on first use and fails
if:

- a variable is missing;
- `DATABASE_URL` does not connect as `app_server` (the owner or service role is never used
  for application writes);
- `DATABASE_URL` or `SUPABASE_URL` points at a local host in preview or production.

Importing `src/lib/env/server.ts` from a Client Component fails the build
(`tests/integration/client-import.test.ts` checks this).

## Variables

| Name                       | Purpose                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`             | Postgres as `app_server`. Hosted: the transaction pooler URL (port 6543) with user `app_server.<project-ref>` and `sslmode=require`. |
| `SUPABASE_URL`             | Supabase API URL.                                                                                                                    |
| `SUPABASE_PUBLISHABLE_KEY` | Used by the server for Supabase Auth sign-in and MFA.                                                                                |
| `SUPABASE_SECRET_KEY`      | Supabase Auth **admin** API only (create and ban staff users).                                                                       |
| `TEST_ADMIN_DATABASE_URL`  | Tests only, local stack only. Never set on Vercel.                                                                                   |
| `NEXT_BUILD_CPUS`          | Optional. Number of build workers (default 2).                                                                                       |

## Local

```bash
npm ci
npx supabase start          # applies migrations and supabase/seed.sql
cp .env.example .env.local  # fill the keys from `npx supabase status`
npm run dev
```

`supabase/seed.sql` sets the local-only password for `app_server`.

## Setting up a hosted environment (preview or production)

1. Create the Supabase project. Enable TOTP MFA (Authentication → Multi-Factor), turn off
   sign-ups (Authentication → Sign In / Providers), and set a strong password policy. These
   match `supabase/config.toml`.
2. Apply migrations from CI or a trusted machine: `npx supabase link --project-ref <ref>`
   then `npx supabase db push`. Production needs a manual approval step.
3. Give the application role a password. Keep it out of the repository:
   ```sql
   alter role app_server with login password '<generated secret>';
   ```
4. Set the variables for **that environment only**, e.g. with the Vercel CLI:
   ```bash
   vercel env add DATABASE_URL preview
   vercel env add SUPABASE_URL preview
   vercel env add SUPABASE_PUBLISHABLE_KEY preview
   vercel env add SUPABASE_SECRET_KEY preview --sensitive
   # repeat with "production" using the production project's values
   ```
   Never reuse production values for preview. Mark every secret as Sensitive.
5. Create the first Super Admin with the variables of that environment:
   ```bash
   BOOTSTRAP_EMAIL=... BOOTSTRAP_NAME="..." BOOTSTRAP_PASSWORD=... npm run bootstrap:admin
   ```
   The script refuses to run once an active Super Admin exists.

The Supabase project owner credentials stay with the Super Admin and are not used by the
application. The audit hash chain makes any owner-level tampering detectable.
