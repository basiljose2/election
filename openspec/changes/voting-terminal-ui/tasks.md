## 1. Shell

- [ ] 1.1 `/terminal` route group with a separate minimal layout and a CI bundle-size check (≤ 150 KB gz); verify CI fails when the budget is exceeded
- [ ] 1.2 Pairing screen (code entry, device short id display) wired to `realtime-device-pairing`; verify two-browser pairing e2e
- [ ] 1.3 Activate screen: fullscreen, AudioContext and test tone, Wake Lock; verify with a Playwright test that ballots are not shown before activation
- [ ] 1.4 Locked screen driven by the state hook; verify reload with no pending session shows locked

## 2. Ballot

- [ ] 2.1 Ballot Definition cache and image preloading on activation/version change; verify unlock-to-first-post < 1 s in e2e timing
- [ ] 2.2 Client ballot reducer (locked → post(i) → review → casting → recorded) using the shared validation module; verify reducer unit tests
- [ ] 2.3 Post screen with EVM rows, lamps, NOTA row, selection rules (N = 1 move, N > 1 cap, NOTA exclusive) and Next gating; verify unit tests for every selection rule in the spec
- [ ] 2.4 Review screen with per-post Change returning to review; verify e2e
- [ ] 2.5 Keyboard operability; verify a keyboard-only Playwright run casts a ballot

## 3. Casting

- [ ] 3.1 Cast with idempotency key and unlimited backoff retry; verify a network-drop e2e (route interception) records exactly one ballot
- [ ] 3.2 Long beep (~2 s) only on success, message for 3 s, then lock; verify the AudioContext call is spied on for success only
- [ ] 3.3 Cancel during ballot → discard and lock without beep; verify two-browser e2e
- [ ] 3.4 After lock, assert no candidate names remain in the DOM and storage is empty; verify with a Playwright DOM/storage assertion

## 4. Kiosk protections

- [ ] 4.1 Suppress the context menu, selection, pinch-zoom and back navigation; verify with Playwright events
- [ ] 4.2 Fullscreen-exit overlay that keeps in-memory choices; verify e2e
- [ ] 4.3 Lint rule banning web storage APIs under `/terminal`; verify lint fails on a test fixture
- [ ] 4.4 Contrast and touch-target audit (axe + size assertions); verify there are no AA violations
