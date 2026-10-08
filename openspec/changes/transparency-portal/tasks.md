## 1. Public data layer

- [ ] 1.1 `public_*` views and `anon` grants; verify `anon` cannot read any other table or Draft Elections (negative tests)
- [ ] 1.2 Rate limiting (Vercel Firewall rule + app limiter) and cache headers on public routes; verify the 61st request per minute is refused

## 2. Public pages

- [ ] 2.1 Public election page (setup, Ballot Definitions, Setup Hash, public key); verify Draft returns 404 and Frozen renders
- [ ] 2.2 Live status board (≤ 15 s freshness); verify with e2e
- [ ] 2.3 Booth Tally list with hash, root, signature and status; verify it matches the Master Terminal hash in e2e
- [ ] 2.4 Public results page from the signed snapshot; verify no per-candidate data before declaration (negative test)

## 3. Verification bundle and verifier

- [ ] 3.1 Bundle generator at declaration (zip in storage) with README; verify the contents list and that selections have no session/time/order fields
- [ ] 3.2 `@campus-evm/verifier` package: setup hash, audit chain, signatures, Merkle roots, answer rule, recount, winner rules; verify PASS on an honest fixture bundle
- [ ] 3.3 Tamper tests: altered vote, removed vote, extra vote, altered audit event, altered result; verify each is detected
- [ ] 3.4 Verifier browser page (local File API, no network) and CLI; verify both produce the same report on the fixture

## 4. Observer view

- [ ] 4.1 Observer audit feed and reconciliation report; verify an open event appears within 15 s and a non-observer is rejected
