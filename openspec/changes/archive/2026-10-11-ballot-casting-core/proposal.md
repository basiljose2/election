## Why

This is the heart of the EVM. When the Presiding Officer presses "Ballot", one voter must
be able to cast exactly one ballot covering every contested Post of the booth, and it
must be stored so that it:
- can never be altered or double-counted
- can never be traced back to the voter
- can be verified by anyone after results are declared

Depends on: `election-setup` (Ballot Definitions), `realtime-device-pairing`
(terminals, signals), `election-state-machines` (booth states and guard registry).

## What Changes

- Ballot Sessions: issued from the Master Terminal, single-use, bound to the booth's Voting Terminal
- Ballot validation per Post: exactly N distinct candidates, or NOTA alone when NOTA is enabled; every mapped contested Post must be answered
- Atomic, exactly-once casting with idempotent retries
- Cancelling a pending Ballot Session (with reason) from the Master Terminal
- Mock (test) ballots through the same path, kept separately and never counted
- The secrecy model: no link between a Vote Selection and a Ballot Session, terminal, time, other Posts, or other selections
- Integrity: append-only, individually signed Vote Selections; per-candidate counts sealed until results are declared
- Registers guards `noPendingBallot`, `mockBallotCast`; hooks for cancel-on-force-close

## Capabilities

### New Capabilities
- `ballot-casting`: issuing, validating, casting and cancelling Ballot Sessions, including mock ballots
- `vote-secrecy-integrity`: how Vote Selections are stored, protected, signed and sealed so ballots are secret and tamper-evident

### Modified Capabilities
- none

## Non-goals

- Terminal screens (`master-terminal-ui`, `voting-terminal-ui`)
- Booth Tally, Merkle root and reconciliation (`booth-close-reconciliation`)
- Result computation and publication (`results-dashboard`, `transparency-portal`)

## Impact

- New tables: ballot_sessions, vote_selections, booth_counters; signing key management
- Strict database grants: the application cannot read Vote Selections directly
- Log redaction rules for all server logs
