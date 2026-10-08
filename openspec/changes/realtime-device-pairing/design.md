## Context

Vercel functions are short-lived and cannot hold WebSocket connections. See
proposal.md (Why) for the requirement to link devices as tightly as an EVM cable.

## Goals / Non-Goals

**Goals:**
- Only the correct devices take part in a booth's poll
- Sub-second signalling when real-time is up, a few seconds when it falls back to polling
- No correctness dependency on real-time delivery

**Non-Goals:**
- Offline voting (a terminal that is offline stays locked; see Risks)

## Decisions

- **Signal bus abstraction.** Define a `SignalBus` interface (`publish(boothId, signal)`
  on the server, `subscribe(token)` on the client). The primary implementation is
  Supabase Realtime private broadcast channels; the fallback implementation is Ably with
  token auth. Keeping it abstract means agents can swap the provider without touching
  the voting logic.
- **Channel authorization.**
  - The server mints a JWT (signed with the Supabase JWT secret) with claims
    `{role: "terminal", booth_id, terminal_id, terminal_type}` and a TTL of 15 minutes.
  - Realtime authorization policies on `realtime.messages` allow SELECT only when the
    topic equals `booth:<booth_id>` from the claims.
  - INSERT (publishing) is allowed only for the server role.
- **Publishing after commit.** The server publishes a signal only after the database
  transaction commits. A lost signal is harmless because clients re-fetch state.
  - The state version number is a per-booth counter incremented in every
    booth-affecting transaction. Clients ignore signals older than the version they
    already have.
- **Credentials.**
  - A 256-bit random token is stored as SHA-256 in `terminals.credential_hash`.
  - Cookie path scoping: `/master` or `/terminal`.
  - The Master Terminal additionally requires the PO's staff session, so it needs two
    things: the PO's login and the registered device.
- **Pairing code.**
  - 6 digits from a CSPRNG, stored hashed, with a 2-minute TTL, an attempt counter,
    and at most one active code per booth.
  - The QR code encodes the pairing URL with the code.
  - The kiosk submits the code, and the server returns a pending pairing with a short
    device id (4 characters, derived from a random device nonce). The PO confirms
    that the id matches what the kiosk displays.
- **Heartbeats.** Terminals POST to a heartbeat endpoint every 10 s. The server upserts
  `last_seen_at` into a small non-audited table (heartbeats are too frequent to audit).
  Status transitions (online → offline) are derived, not stored. A
  `terminal_went_offline` Audit Event is recorded lazily the first time the Master
  Terminal's state fetch observes the transition.

## Secrecy and integrity

Signals and heartbeats carry no vote content. Integrity rests on server-side credential
checks and the database state, never on the signal channel.

## Risks / Trade-offs

- [Campus network or internet outage] → The Voting Terminal fails safe (it stays locked). A pending Ballot Session survives on the server. The runbook requires a backup hotspot.
- [Supabase Realtime private channels change their API] → The `SignalBus` abstraction plus the Ably fallback keeps this contained.
- [Polling load when real-time is down] → One booth pair polling every 2 s is trivial at campus scale.
