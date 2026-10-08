## Why

In a real EVM, the Control Unit and Ballot Unit are joined by a cable, so nothing else
can drive the Ballot Unit. Online, we need an equally strict bond. Only the registered
Master Terminal of a booth may enable only that booth's registered Voting Terminal, and
the two must learn of state changes within about a second. Vercel functions cannot hold
WebSocket connections, so this needs a managed real-time service with the database
remaining the source of truth.

Depends on: `foundation`. Can be built in parallel with `election-setup`. Uses booths from `election-setup`, so stub them until it lands.

## What Changes

- Register a Master Terminal: a PO-signed-in device bound to that PO's booth
- Pair a Voting Terminal using a one-time code or QR code shown on the Master Terminal and confirmed by the PO
- A device credential (HttpOnly cookie) for each terminal, with revocation and replacement
- Private per-booth signalling channels carrying state-change signals only, never vote content
- Heartbeats and online/offline status; polling fallback when real-time is unavailable
- An authoritative "terminal state" endpoint that clients re-fetch on every signal

## Capabilities

### New Capabilities
- `terminal-pairing`: registering Master and Voting Terminals to a Polling Booth, credentials, replacement and revocation
- `terminal-signaling`: private per-booth real-time signals, heartbeats, online status and fallback polling

### Modified Capabilities
- none

## Non-goals

- What happens when a ballot is enabled or cast (`ballot-casting-core`)
- Terminal screens beyond the pairing screens (`master-terminal-ui`, `voting-terminal-ui`)

## Impact

- New tables: terminals, pairing_codes, terminal_heartbeats
- A real-time provider (Supabase Realtime; Ably as fallback) and server-minted channel tokens
- New server endpoints: pair, confirm pairing, heartbeat, terminal state, channel token
