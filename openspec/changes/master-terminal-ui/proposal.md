## Why

The Presiding Officer needs a Control Unit: one clear screen showing the booth's state,
the Voting Terminal's health and the ballots-cast count, with a large Ballot button and
the mock poll, open and close controls. Mistakes here (a double-enabled ballot, an
accidental close) must be hard to make.

Depends on: `ballot-casting-core` (and transitively everything before it). Can be built
in parallel with `voting-terminal-ui` and `booth-close-reconciliation`.

## What Changes

- Master Terminal app route for the Presiding Officer, tablet- and laptop-friendly
- Booth status header, Voting Terminal status (online/offline, last heartbeat), connection mode (real-time or polling)
- Pairing and replacement flow screens (using `realtime-device-pairing` commands)
- A large Ballot button with Ready / Busy lamps, EVM-style
- Cancel pending ballot with a reason picker
- Mock poll controls: start, view mock results, clear, repeat
- Open poll and close poll with confirmations and re-authentication
- A screen lock after idle, requiring the PO's password

## Capabilities

### New Capabilities
- `master-terminal`: the Presiding Officer's control-unit screen and its interaction rules

### Modified Capabilities
- none

## Non-goals

- Booth Tally display after close (`booth-close-reconciliation`)
- Any display of real per-candidate counts (never shown on the Master Terminal)

## Impact

- New UI routes under `/master`; uses the existing commands and state endpoint only
