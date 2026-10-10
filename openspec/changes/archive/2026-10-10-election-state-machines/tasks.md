## 1. Transition engine

- [x] 1.1 Declarative transition tables for Election and Booth in TypeScript; verify a unit test enumerates every (state, action) pair and asserts only the listed transitions succeed
- [x] 1.2 Guard registry with fail-closed stubs and `onTransition` hook registry; verify an unregistered guard blocks the transition
- [x] 1.3 `transition()` command: row lock, guards, compare-and-set, audit, state version increment, publish-after-commit signal; verify a concurrency test where two parallel identical requests give exactly one success
- [x] 1.4 SQL status triggers mirroring the tables, plus a CI test that the TS and SQL tables match; verify a direct SQL update to an illegal status is rejected (negative test)

## 2. Election transitions

- [x] 2.1 Start polling (Frozen → Polling Open) by RO; verify role and scope negative tests
- [x] 2.2 Complete all polls (all booths Closed → Sealed; election → Polling Completed) with re-auth; verify rejection naming an open booth
- [x] 2.3 Archive by Super Admin; verify an RO is rejected

## 3. Booth transitions

- [x] 3.1 Start mock poll with terminal guards; verify rejection without a Voting Terminal
- [x] 3.2 Clear mock poll with `mockBallotCast` guard and mock counts in audit (fixture data); verify rejection with zero mock ballots
- [x] 3.3 Repeat mock poll (Mock Cleared → Mock Poll); verify with a unit test
- [x] 3.4 Open poll with all guards and re-auth; verify one negative test per guard
- [x] 3.5 Close poll with `noPendingBallot` guard and re-auth; verify reopen is rejected
- [x] 3.6 RO force close with a mandatory reason, cancelling any pending Ballot Session (fixture); verify the reason is in the Audit Event
