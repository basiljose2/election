## 1. Shell and status

- [ ] 1.1 `/master` route: PO sign-in → device registration → dashboard; verify e2e reaches the dashboard only with a PO session and a registered device
- [ ] 1.2 Server-computed `allowedActions` added to the master state response; verify a unit test per booth state
- [ ] 1.3 BoothHeader, TerminalStatus (online/offline, last heartbeat, connection mode) and counters; verify Playwright shows offline within 5 s after heartbeats stop
- [ ] 1.4 Mock mode banner and tint; verify visual test in Mock Poll

## 2. Ballot flow

- [ ] 2.1 Lamps and BallotButton with in-flight disable; verify a rapid double click sends one request (network assertion)
- [ ] 2.2 Busy → Ready update on ballot-cast signal and state fetch; verify a two-browser test in which the master count increments within 2 s
- [ ] 2.3 CancelDialog with reason picker; verify the cancel e2e and count update

## 3. Mock, open, close

- [ ] 3.1 MockPanel: start, mock result table, clear (with confirmation showing counts), repeat; verify e2e over a full mock round
- [ ] 3.2 Open dialog with re-auth and a "count is 0" statement; verify stale re-auth is rejected
- [ ] 3.3 Close dialog with typed CLOSE and re-auth; disabled with a reason while busy; verify both paths
- [ ] 3.4 Assert that no real per-candidate data is requested by `/master` (network log test)

## 4. Lock

- [ ] 4.1 Idle lock overlay after 5 min with password unlock; verify with a clock-mocked Playwright test that actions are blocked while locked
