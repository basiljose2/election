## 1. Data model

- [ ] 1.1 Migrations for terminals (booth_id, type, credential_hash, status, revoked_at), pairing_codes (hash, expires_at, attempts), terminal_heartbeats, and a per-booth state_version counter; verify with SQL constraint tests (at most one active terminal per type per booth)

## 2. Credentials and pairing

- [ ] 2.1 Terminal credential issue/verify/revoke helpers with hashed storage and scoped cookies; verify unit tests for tampered, revoked and wrong-booth credentials (negative tests)
- [ ] 2.2 Master Terminal registration command (PO session + device), revoking any previous master; verify e2e and audit
- [ ] 2.3 Pairing code generation on the master (6 digits + QR, 2 min TTL, single use); verify with a clock-mocked expiry test
- [ ] 2.4 Kiosk code submission → pending pairing with a short device id → PO confirm/reject; verify a two-browser Playwright test
- [ ] 2.5 Attempt limit (5) and rate limiting per IP on code submission; verify the 6th attempt is rejected and audited
- [ ] 2.6 Replacement rules (revoke previous; blocked while a Ballot Session is pending, tested via a fixture); verify with a negative test
- [ ] 2.7 Pairing allowed only in Frozen/Polling Open elections and before booth close; verify with a negative test on a Closed booth fixture
- [ ] 2.8 Terminal-type authorization middleware (a Voting Terminal cannot call master commands); verify with a negative test

## 3. Signalling

- [ ] 3.1 `SignalBus` interface with a Supabase Realtime implementation and an in-memory test implementation; verify with unit tests
- [ ] 3.2 Channel token minting endpoint (15 min TTL, booth-scoped) and realtime authorization policies; verify a foreign subscriber and a publishing terminal are refused
- [ ] 3.3 Publish-after-commit helper with state version; verify a signal is not sent when the transaction rolls back
- [ ] 3.4 Terminal state endpoint (booth state, pending ballot flag, count for master only, version); verify the Voting Terminal response never contains the count or any choice data
- [ ] 3.5 Client hook: subscribe, re-fetch on signal/reconnect/load, ignore stale versions, fall back to 2 s polling; verify a Playwright test with real-time blocked unlocks within 3 s
- [ ] 3.6 Heartbeat endpoint (10 s interval) and derived online/offline (30 s); verify with a clock-mocked test and a master UI indicator
- [ ] 3.7 Ably implementation of `SignalBus` behind an env switch; verify the same contract tests pass against both implementations
