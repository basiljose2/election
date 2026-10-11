## 1. Polling dashboard

- [x] 1.1 RO election dashboard with booth rows (state, terminal status, counts, last activity) and totals, live via the election channel with 5 s polling fallback; verify e2e that the count updates within 10 s
- [x] 1.2 "Complete all polls" checklist with per-booth force-close; verify disabled while a booth is Open and enabled after all close
- [x] 1.3 Assert that no per-candidate data is present before declaration (response schema test, negative)

## 2. Result computation

- [x] 2.1 Pure `computePostResult` shared package; verify table-driven tests for every spec scenario plus property-based tests
- [x] 2.2 NOTA reporting and "NOTA exceeded winner" flag; verify a unit test
- [x] 2.3 Uncontested and withheld handling; verify a mixed fixture (one uncontested, one withheld, one normal)

## 3. Declaration

- [x] 3.1 Append-only results/result_items tables; verify UPDATE/DELETE are rejected (negative test)
- [x] 3.2 Declaration command (lock, reconcile, tally, compute, store, sign, audit, transition) with re-auth; verify fault injection leaves the Election in Polling Completed with no Result
- [x] 3.3 Declare-once guard; verify a second declaration is rejected

## 4. Results dashboard and exports

- [x] 4.1 Summary tiles, per-Post cards with bar charts, badges (Elected/Tie/Withheld/Unopposed/NOTA exceeded) and margins; verify visual tests on the fixture
- [x] 4.2 Booth-wise table; verify totals equal the per-Post totals
- [x] 4.3 PDF, CSV and signed JSON exports with the Result hash; verify the JSON signature with the public key and that the PDF text contains the hash
