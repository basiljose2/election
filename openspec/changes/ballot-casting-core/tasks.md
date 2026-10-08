## 1. Data model and grants

- [ ] 1.1 Migrations for ballot_sessions, vote_selections (no timestamp/serial columns), booth_counters; verify a schema test asserts vote_selections has no timestamp, sequence or session reference columns
- [ ] 1.2 Append-only triggers and grants: vote_selections INSERT-only for app_server (no SELECT); ballot_sessions immutable once Cast/Cancelled; verify negative SQL tests for SELECT, UPDATE and DELETE
- [ ] 1.3 `vote_reader` SECURITY DEFINER functions (mock_counts, booth_integrity_digest, election_tally) with internal state checks; verify election_tally raises during Polling Open (negative test)

## 2. Signing

- [ ] 2.1 Per-election Ed25519 key pair generated on freeze (hook into freeze), private key envelope-encrypted with the env master key, public key published; verify a signature round-trip test and that the private key never appears in any API response
- [ ] 2.2 Canonical selection serialisation and a signature helper shared with the public verifier; verify with golden test vectors

## 3. Issue and cancel

- [ ] 3.1 Issue Ballot Session command (master + PO session, booth Open/Mock Poll, terminal online, none pending); verify one negative test per guard
- [ ] 3.2 Pending ballot fetch for the bound Voting Terminal only (Ballot Definition + single-use cast token); verify another device is rejected
- [ ] 3.3 Cancel command with a fixed reason list, cancelled counter and audit; verify cast-after-cancel is rejected
- [ ] 3.4 Register guards `noPendingBallot` and `mockBallotCast`, plus a force-close hook that cancels a pending session; verify via the state-machine guard tests with real data

## 4. Cast

- [ ] 4.1 Ballot validation (exactly N distinct, NOTA exclusive and only if enabled, all mapped contested posts, no extras); verify a table-driven unit test covering every scenario in the spec
- [ ] 4.2 Atomic cast transaction with row lock, counter, audit, state version and post-commit signal; verify fault injection leaves no partial rows
- [ ] 4.3 Idempotency key handling; verify a same-key retry returns success with a single stored ballot, and a different key is rejected
- [ ] 4.4 Concurrency test: 20 parallel casts for one session store exactly one ballot
- [ ] 4.5 Response and signal payloads contain no choices; verify with a contract test that snapshots the response and signal shapes

## 5. Mock ballots and secrecy guards

- [ ] 5.1 Mock round tracking, mock flagging and exclusion from real counters; verify the mock-then-real scenario in the spec
- [ ] 5.2 Mock counts endpoint for the booth PO (current round only); verify a PO of another booth is rejected
- [ ] 5.3 Logger wrapper with body redaction for terminal routes, plus a lint rule banning console.* in casting modules; verify a test that a failed cast log line contains no choice ids
- [ ] 5.4 Secrecy test: after 50 random casts, assert no column or join path links vote_selections to ballot_sessions, and exported rows sorted by id are uncorrelated with cast order (rank correlation test)
