## Context

This change is UI only, over the commands and state endpoint from earlier changes. The
target devices are a laptop or tablet in landscape, operated by a trained Presiding
Officer.

## Goals / Non-Goals

**Goals:**
- Impossible to act on stale state
- Every disabled control explains why

**Non-Goals:**
- Offline operation

## Decisions

- **State-driven rendering.** The screen is a pure function of the latest terminal
  state (from the `realtime-device-pairing` client hook). Button availability is taken
  from an `allowedActions` list the server computes from the transition table. The UI
  never re-implements the rules.
- **Optimistic UI is not allowed.** After an action, the UI shows a pending spinner
  and waits for the server response and the next state fetch before changing the
  lamps. This avoids ever showing Ready while the server still has a session pending.
- **EVM look.** The screen uses the dark-grey panel style of an EVM Control Unit, with
  Ready (green) and Busy (red) lamps, a large "BALLOT" button (≥ 120 px tall), and big
  counters.
- **Idle lock.** A client-side lock overlay after 5 min. Unlocking calls the
  re-authentication endpoint, so even if the overlay were removed in dev tools the
  server would still require a fresh session for critical actions.
- **Components.** `BoothHeader`, `TerminalStatus`, `Lamps`, `BallotButton`,
  `CancelDialog`, `MockPanel`, `OpenCloseDialogs`, `LockOverlay`. Keep them in one
  route so they share the state hook.

## Secrecy and integrity

Mock results are the only per-candidate data shown, and they come from the mock-only
reader function. Real counts are never requested by this UI.

## Risks / Trade-offs

- [The PO leaves the master unattended] → Idle lock plus the need for a PO session.
- [Confusing mock and real modes] → Persistent banner, different background tint in mock mode, and a confirmation on open stating that counts reset to 0.
