## Why

The voter's experience must feel like pressing a button on an EVM Ballot Unit: obvious,
fast, private, and ending with the familiar long beep. It must also handle several
Posts per ballot, Posts with several seats, and NOTA, while making invalid or
incomplete ballots impossible to submit.

Depends on: `ballot-casting-core`. Can be built in parallel with `master-terminal-ui`
and `booth-close-reconciliation`.

## What Changes

- Kiosk route for the Voting Terminal: pairing screen, activation (fullscreen + audio unlock), locked screen
- EVM-style ballot: one screen per Post showing serial, photo, name and symbol with a button and lamp per Candidate, plus NOTA when enabled
- Selection rules in the UI: exactly N for N-seat Posts, NOTA exclusive, no skipping
- A review-and-confirm screen, then cast with idempotent retry
- A long beep and "vote recorded" message, then immediate re-lock
- Kiosk protections: fullscreen guard, no navigation, no context menu, no stored choices

## Capabilities

### New Capabilities
- `voting-terminal`: the voter-facing ballot unit screen and kiosk behaviour

### Modified Capabilities
- none

## Non-goals

- Accessibility audio ballot (possible future change)
- Multiple languages (strings are externalised so this can be added later)

## Impact

- New UI route under `/terminal` with a minimal bundle; Ballot Definition and image preloading
