# Dress rehearsal

A full rehearsal on the **production deployment** is a release gate: at least 3 booths, a
multi-seat Post, a booth-specific Post and NOTA enabled, from setup to declaration, ending
with the verifier passing and the declared counts equal to the script's expected counts.

The same script runs automatically as `tests/integration/rehearsal.test.ts` (it drives the
real commands and casting path and checks the expected counts); run the production rehearsal
by hand with real devices so the people and the procedures are rehearsed too.

## The script

| Booth   | Votes on                             | Ballots (President / Council / Sports)                                           |
| ------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| Booth 1 | President, Council                   | 1: A / A,B · 2: A / A,C · 3: B / B,C · 4: NOTA / A,B                             |
| Booth 2 | President, Council                   | 1: A / A,B · 2: C / A,D · 3: B / NOTA · plus 1 **cancelled** ballot (voter left) |
| Booth 3 | President, Council, Sports Secretary | 1: A / B,C / A · 2: B / A,B / B · 3: A / A,B / NOTA · 4: A / C,D / A             |

Setup: President (1 seat, candidates A-C), Council (**2 seats**, candidates A-D), Sports
Secretary (1 seat, candidates A-B, **only at Booth 3**), NOTA enabled.

### Expected counts

| Post             | Candidate votes       | NOTA | Outcome                    |
| ---------------- | --------------------- | ---- | -------------------------- |
| President        | A 6 · B 3 · C 1       | 1    | A elected (margin 3)       |
| Council          | A 7 · B 7 · C 4 · D 2 | 1    | A and B elected (margin 3) |
| Sports Secretary | A 2 · B 1             | 1    | A elected (booth 3 only)   |

Totals: **11 ballots cast, 1 cancelled, 3 booths.** NOTA is never elected, and no Post is
flagged "NOTA exceeded winner" or tied in this script. (The automated test computes the same
counts from the ballots above and compares them with the declared Result.)

## Procedure

1. Do the **pre-poll checklist** in full at every booth (`pre-poll-checklist.md`).
2. Cast the scripted ballots at each booth, in any order, using real voters or staff.
3. Cancel the scripted ballot at Booth 2.
4. Close every booth; collect the printed Booth Tallies.
5. RO: Complete all polls, **Run reconciliation** (all PASS), **Declare results**.
6. Compare the Results page with the expected counts above.
7. Download the verification bundle and run
   `node tools/verifier/verify-bundle.mjs <bundle.zip>`: it must print `ALL CHECKS PASSED`
   with the dashboard's Result hash. Also open `/verify` in a browser and verify the same
   file there.
8. Check at least one agent's written tally hash against the public tally list.
9. Run the **restore drill** on this election (`restore-drill.md`).
10. Walk through **each** incident in `polling-day-incidents.md` once on the rehearsal
    (fail a kiosk, fail a Master Terminal, pull the network, pull the power, force-close an
    "unreachable" booth) and note anything that did not work as written.

## Sign-off

| Item                                 | Done by | Date | Evidence |
| ------------------------------------ | ------- | ---- | -------- |
| Rehearsal declared; counts match     |         |      |          |
| Verifier PASS (CLI and browser)      |         |      |          |
| Restore drill VERIFIED               |         |      |          |
| Each incident procedure exercised    |         |      |          |
| Gaps found and fixed in the runbooks |         |      |          |
