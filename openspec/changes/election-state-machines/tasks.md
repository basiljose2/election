## 1. Transition engine

- [ ] 1.1 Declarative transition tables for Election and Booth in TypeScript; verify a unit test enumerates every (state, action) pair and asserts only the listed transitions succeed
- [ ] 1.2 Guard registry with fail-closed stubs and `onTransition` hook registry; verify an unregistered guard blocks the transition
- [ ] 1.3 `transition()` command: row lock, guards, compare-and-set, audit, state version increment, publish-after-commit signal; verify a concurrency test where two parallel identical requests give exactly one success
- [ ] 1.4 SQL status triggers mirroring the tables, plus a CI test that the TS and SQL tables match; verify a direct SQL update to an illegal status is rejected (negative test)

## 2. Election transitions

- [ ] 2.1 Start polling (Frozen → Polling Open) by RO; verify role and scope negative tests
- [ ] 2.2 Complete all polls (all booths Closed → Sealed; election → Polling Completed) with re-auth; verify rejection naming an open booth
- [ ] 2.3 Archive by Super Admin; verify an RO is rejected

## 3. Booth transitions

- [ ] 3.1 Start mock poll with terminal guards; verify rejection without a Voting Terminal
- [ ] 3.2 Clear mock poll with `mockBallotCast` guard and mock counts in audit (fixture data); verify rejection with zero mock ballots
- [ ] 3.3 Repeat mock poll (Mock Cleared → Mock Poll); verify with a unit test
- [ ] 3.4 Open poll with all guards and re-auth; verify one negative test per guard
- [ ] 3.5 Close poll with `noPendingBallot` guard and re-auth; verify reopen is rejected
- [ ] 3.6 RO force close with a mandatory reason, cancelling any pending Ballot Session (fixture); verify the reason is in the Audit Event
