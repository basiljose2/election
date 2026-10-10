## Context

The kiosk runs on a tablet or laptop, ideally in Chrome kiosk mode (see the `hardening`
runbook). Browsers block audio until a user gesture, and they let users exit
fullscreen, so both need handling.

## Goals / Non-Goals

**Goals:**
- Instant unlock
- Impossible to submit an invalid ballot
- Nothing left behind after casting

**Non-Goals:**
- Controlling the operating system (kiosk mode is configured outside the app)

## Decisions

- **Minimal bundle.** A separate route group with no admin code. Target ≤ 150 KB
  gzipped JS, enforced by a CI size check.
- **Preloading.** Ballot Definitions are public after freeze, so on activation (and
  whenever the state version changes) the terminal fetches and caches the definition
  and preloads candidate images in memory. Enabling a ballot then only needs the cast
  token, which makes the 1-second target easy.
- **Ballot state machine in the client.** A reducer with states `locked`,
  `post(i)`, `review`, `casting`, `recorded`. The same validation module as the server
  (a shared package) decides whether Next and Cast are enabled.
- **Beep.** Web Audio API oscillator: sine at about 1 kHz for 2 s, with short
  fade-in and fade-out to avoid clicks. The AudioContext is created during the Activate
  gesture and resumed on each state change.
- **Idempotency key.** `crypto.randomUUID()` generated when "Cast my vote" is pressed
  and kept in memory only. The terminal retries with exponential backoff (0.5 s → 4 s,
  unlimited retries) until it gets success, "already cast with this key" (treated as
  success), or "session cancelled".
- **Clearing state.** On `recorded` or cancel, the reducer resets to `locked`, and the
  ballot components unmount so the DOM holds no names. There is no persistence layer
  in this route; a lint rule bans `localStorage`, `sessionStorage` and `indexedDB`
  under `/terminal`.
- **EVM look.** A light-grey Ballot Unit panel. Each row has the serial number, photo,
  name, symbol, a red lamp and a blue oval button.

## Secrecy and integrity

Choices exist only in React state during a session, are sent once over HTTPS, and are
discarded afterwards. No voter-visible screen can show the Master Terminal's counts.

## Risks / Trade-offs

- [The voter exits fullscreen and reaches the browser UI] → Overlay plus kiosk mode. The runbook requires OS-level kiosk configuration.
- [The device sleeps] → Screen Wake Lock API on activation. The runbook covers OS power settings.
- [An observer shoulder-surfs] → Physical booth layout, as with paper voting. The Voting Terminal is placed behind a screen.
