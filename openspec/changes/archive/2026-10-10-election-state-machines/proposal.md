## Why

An EVM is trustworthy largely because it only does the right thing at the right time.
It can't record votes before the poll opens, can't reopen after closing, and can't
count test votes. The Election and each Polling Booth need explicit, server-enforced
lifecycles so that every other feature asks one authority "is this allowed now?".

Depends on: `election-setup` (which owns Draft ⇄ Frozen). Can be built in parallel with
`realtime-device-pairing`.

## What Changes

- Election lifecycle: Draft → Frozen → Polling Open → Polling Completed → Results Declared → Archived
- Booth lifecycle: Setup → Mock Poll → Mock Cleared → Open → Closed → Sealed
- A single transition engine with guards, re-authentication for critical transitions, and an Audit Event per transition
- Returning Officer force-close of an open booth, with a reason
- Guard hooks that later changes plug into (pending ballot checks, mock counts, reconciliation)

## Capabilities

### New Capabilities
- `election-lifecycle`: the allowed states and transitions of Elections and Polling Booths, and the guards on each transition

### Modified Capabilities
- none

## Non-goals

- Casting, mock-vote recording and tallies (`ballot-casting-core`, `booth-close-reconciliation`)
- Result computation (`results-dashboard`)
- Screens (the UI changes call these transitions)

## Impact

- Adds status columns and transition tables; the transition engine is used by every later change
