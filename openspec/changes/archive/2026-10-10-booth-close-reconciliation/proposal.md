## Why

When a booth closes, everyone present (the Presiding Officer and candidates' agents)
needs a fixed, signed record of what the booth produced, like the paper "account of
votes recorded" in EVM elections. Before results are declared, the system must prove
that every booth's stored votes still match that record, that signatures are valid and
that the audit chain is intact. Otherwise, a result can't be trusted.

Depends on: `ballot-casting-core`. Can be built in parallel with the two terminal UIs.

## What Changes

- A Booth Tally generated in the close transaction: ballots cast/cancelled, per-Post answer totals, a Merkle root over the booth's real Vote Selections, and a server signature
- Booth Tally display on the Master Terminal, with a printable view and a QR code of its hash
- Election reconciliation: re-verify every booth against its Booth Tally, all signatures, answer totals, the audit chain, and the Setup Hash and Ballot Definitions
- A reconciliation report for the Returning Officer and Observers (no per-candidate counts)
- Registers the `reconciliationPassed` guard used by result declaration

## Capabilities

### New Capabilities
- `booth-reconciliation`: Booth Tally generation at close and election-wide integrity checks before results

### Modified Capabilities
- none

## Non-goals

- Computing winners (`results-dashboard`)
- Public publication of tallies and verification bundles (`transparency-portal`)

## Impact

- New append-only table booth_tallies; reader functions from `ballot-casting-core` are extended with the digest; a Master Terminal close screen
