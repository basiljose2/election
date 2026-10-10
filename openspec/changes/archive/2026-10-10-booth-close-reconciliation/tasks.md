## 1. Merkle and digest

- [x] 1.1 Shared Merkle package (TS) with published test vectors; verify golden tests including odd leaf counts and a single leaf
- [x] 1.2 SQL `booth_integrity_digest` (row count, answers per post with divisibility flag, signature validity, Merkle root, unmapped-post check) matching the TS package; verify cross-implementation tests on the same fixture give identical roots

## 2. Booth Tally

- [x] 2.1 Append-only `booth_tallies` table and close hook creating a signed tally (PASS/FAILED with reasons); verify one test for normal close and one for force close
- [x] 2.2 RO dashboard alert on a FAILED tally; verify with a fixture where a selection is withheld
- [x] 2.3 Master Terminal post-close screen: counts, short hash, QR of the full hash, print view; verify e2e after close

## 3. Election reconciliation

- [x] 3.1 Election reconciliation command running every check in the spec and auditing the outcome; verify one negative test per check (post-close insert, bad signature, altered audit event, altered Ballot Definition, pending session)
- [x] 3.2 Per-Post PASS/FAILED computation and `reconciliationPassed` guard registration; verify the one-booth-fails scenario
- [x] 3.3 Reconciliation report page for RO and Observers; verify it contains no per-candidate numbers (response schema test)
