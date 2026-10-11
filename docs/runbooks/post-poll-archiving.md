# Post-poll procedure and archiving

## 1. Close the polls (PO, then RO)

1. At the scheduled time each PO presses **Close poll**, types `CLOSE`, enters their password.
   If a ballot is pending, wait for the voter or cancel it first (the button explains).
2. The Master Terminal then shows the **Booth Tally**: ballots cast and cancelled, ballot
   answers per Post, a short hash, a QR code of the full hash. **Agents write down or
   photograph the short hash and the QR**, and the PO prints the page (Print button). This
   is the paper "account of votes" and it can be compared later with the public tally.
3. Compare the cast count with the paper register. A mismatch is **reported, not repaired**:
   tell the RO and note it in the log.

## 2. Complete the polls (RO)

1. Open the election **Dashboard**. The checklist lists any booth not yet Closed with a
   _Force close_ option (use only for an unreachable PO or a broken booth; a reason is
   required and recorded).
2. When every booth is Closed, **Complete all polls**.
3. Open the **Reconciliation report** and **Run reconciliation**. Read it with an Observer
   or agent present:
   - every booth shows PASS for: tally signature, stored votes match the tally (count and
     Merkle root), every vote signature valid, answers equal ballots cast, nothing on an
     unmapped Post;
   - election-wide: audit chain intact, setup and Ballot Definitions unchanged, no ballot
     pending.
     Any FAILED item withholds the affected Posts from the declaration (nothing is "fixed").
     Escalate to the SA before declaring.

## 3. Declare (RO)

1. **Declare results** (you re-enter password and authenticator code). Declaration runs the
   reconciliation again, reveals the counts, signs the Result and cannot be repeated.
2. Open **Results**: check the totals, each Post's Elected / Tie / Withheld status, NOTA
   flags and the Result hash. A Tie is **not** resolved by the system; the decision is made
   outside it.
3. Read the **Result hash** aloud to the representatives and write it in the log.

## 4. Archive (RO and SA)

Do all of these the same day and store them in at least two places (an institutional drive
and an offline copy):

| Item                                    | How                                                        | Why                                        |
| --------------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| Result PDF, CSV and signed JSON         | Results page → downloads                                   | the official, hash-stamped record          |
| Verification bundle (zip)               | public election page → bundle                              | everything needed to recount independently |
| Bundle hash                             | printed in the file name; `sha256sum` it                   | detects later change                       |
| Audit export (election chain)           | `/api/audit/<election-id>/export` while signed in as RO/SA | the hash-chained event log                 |
| Audit export (system chain)             | `/api/audit/system/export` as SA                           | account events around the election         |
| Printed Booth Tallies and the paper log | from the booths                                            | the human record                           |

3. **Verify the archive** on a machine that is not a server:
   `node tools/verifier/verify-bundle.mjs verification-bundle-<hash>.zip` must print
   `ALL CHECKS PASSED` and the same Result hash as the dashboard. Attach the output.
4. Take (or confirm) a database backup / PITR marker **after** declaration and note its time.
5. The SA **archives** the election (read-only afterwards). Terminals stop working at that
   point.

## 5. Retention and disposal

Keep the bundle, audit exports and paper records for the period your institution's rules
require. The database contains no voter identities; it contains signed, unlinkable vote rows
which are public once the bundle is published. Revoke staff accounts and device credentials
that are no longer needed.
