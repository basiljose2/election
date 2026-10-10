## Context

`election-setup` owns Draft ⇄ Frozen. This change owns everything after, plus booth
states. Some guards depend on data owned by later changes (pending Ballot Sessions,
mock ballot counts, terminal online status).

## Goals / Non-Goals

**Goals:**
- One place that decides whether a transition is allowed
- Race-free transitions

**Non-Goals:**
- The effects of transitions owned by other changes, such as generating the Booth Tally on close

## Decisions

- **Declarative transition table.** Represent both machines as data:
  `{from, to, action, allowedRoles, guards[], requiresReauth}`. A single
  `transition(entity, action, actor)` function looks up the row, runs the guards, and
  applies the change. This is easy to review and easy to test exhaustively.
  - Alternative considered: XState. Rejected because the server-side check is a small
    pure function, and XState adds weight without benefit here.
- **Guard registry.** Guards are named functions registered by the change that owns
  their data:
  - `noPendingBallot` and `mockBallotCast` → `ballot-casting-core`
  - `votingTerminalOnline` → `realtime-device-pairing`
  - `reconciliationPassed` → `booth-close-reconciliation`

  Until the owner lands, the guard is registered as a stub that fails closed.
  Tests use fixtures.
- **Transition hooks.** Changes may register `onTransition` hooks that run inside the
  same transaction, for example closing a booth generates its Booth Tally.
- **Concurrency.** `SELECT ... FOR UPDATE` on the booth or election row inside the
  transaction, then compare-and-set on status. Loser requests fail with
  `INVALID_TRANSITION`.
- **Database defence in depth.** A trigger on status columns rejects any transition not
  in an SQL copy of the transition table. A CI test checks that the TypeScript table and
  the SQL table are identical.

## Secrecy and integrity

The mock-clear Audit Event contains mock per-candidate counts. Mock votes are test data
that the PO and agents are meant to see, so this is intended and doesn't breach secrecy.
No real vote data is touched.

## Risks / Trade-offs

- [The two copies of the transition table (TS and SQL) drift apart] → The CI equality test fails the build.
- [A stub guard left in place permanently] → Stubs fail closed, so a missing guard blocks the action instead of allowing it.
