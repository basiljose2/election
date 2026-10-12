# Erasing test data (test and rehearsal databases only)

Election data is append-only on purpose, so a **real** election can never be edited or
deleted through the application. For a test or rehearsal database there is a separate,
deliberately awkward way to wipe everything and start again.

## What it erases, what it keeps

| Erased                                                                                                                                                                              | Kept                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Elections and everything under them: setup, booths, terminals, pairing codes, ballot sessions, vote rows, tallies, reconciliation runs, results, verification bundles, signing keys | Staff accounts and their sign-in sessions           |
| Staff role assignments scoped to an election or booth                                                                                                                               | Super Admin role assignments                        |
| The whole audit log (the erase becomes event 1 of the new chain)                                                                                                                    | Sign-in throttling records                          |
| Uploaded candidate images                                                                                                                                                           | The reference tables of permitted state transitions |

## The two locks

1. **A database switch the application cannot change.** `public.deployment_settings.allow_data_erase` is `false` by default (and on every
   production database). The application role has read-only access to it, so a compromised application or Super Admin
   cannot turn it on. Only the database owner can.
2. **The application checks.** The Super Admin opens **Test data** (from the staff home page),
   must have re-authenticated (password and authenticator code) within 5 minutes, and must type
   `ERASE ALL DATA`. The erase is audited.

## Turning it on (database owner)

In the Supabase dashboard SQL editor for the **test** project (never a real election):

```sql
update public.deployment_settings set allow_data_erase = true, changed_at = now();
```

Or from a terminal with the CLI linked to that project:

```
npx supabase db query --linked "update public.deployment_settings set allow_data_erase = true, changed_at = now()"
```

The Test data page then shows "Erasing is switched ON". After you are done, switch it off
again:

```sql
update public.deployment_settings set allow_data_erase = false, changed_at = now();
```

## After erasing

- Assign Returning Officers and Presiding Officers again (their election roles are gone).
- Any terminal paired to an erased booth is unpaired; pair afresh.
- The public pages show no elections until a new one is frozen.

## Before a real election

Confirm the switch is off. The page shows it, and this query returns `false`:

```sql
select allow_data_erase from public.deployment_settings;
```
