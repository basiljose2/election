## Why

Transparency means people outside the Returning Officer's office can check the election
for themselves. Before polling, they can see exactly what is on every ballot. During
polling, they can watch turnout live. After declaration, they can download everything
needed to recount and verify the result independently, without trusting the server.

Depends on: `booth-close-reconciliation` (tallies, Merkle package). The results pages
need `results-dashboard`, so build those last within this change.

## What Changes

- Public election page (no login): frozen setup, Ballot Definitions per booth, Setup Hash, public signing key
- Public live status board: booth states and ballots cast/cancelled
- Booth Tallies published as each booth closes
- Public results page after declaration (read-only version of the dashboard)
- A verification bundle after declaration: setup, audit chain, Booth Tallies, anonymised Vote Selections per booth with signatures, and the signed Result
- An open verifier (in-browser page and Node CLI) that recomputes every hash, signature, Merkle root, recount and winner
- An Observer view: live audit event feed and reconciliation report

## Capabilities

### New Capabilities
- `public-transparency`: public pages, the verification bundle and the independent verifier

### Modified Capabilities
- none

## Non-goals

- Any per-candidate data before declaration
- Voter-level receipts (excluded to prevent coercion)

## Impact

- New public routes with caching; public read-only database views; a verifier package published in the repository
