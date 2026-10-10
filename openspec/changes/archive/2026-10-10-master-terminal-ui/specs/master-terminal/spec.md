## Purpose

Gives the Presiding Officer an EVM Control Unit style screen to supervise their Polling
Booth: see status and counts, enable one ballot at a time, run the mock poll, and open
and close the poll.

## ADDED Requirements

### Requirement: Status display
The Master Terminal SHALL continuously show:
- the Election and booth names
- the booth state
- the Voting Terminal's status (online/offline, with time since last heartbeat)
- the connection mode (real-time or polling fallback)
- the ballots-cast count and the ballots-cancelled count

During Mock Poll, it SHALL show the mock ballot count for the current round in place of
the real counts, with a clear "MOCK POLL" banner.

#### Scenario: Terminal goes offline
- **WHEN** the Voting Terminal stops sending heartbeats for 30 seconds
- **THEN** the Master Terminal shows it as offline within 5 seconds and disables the Ballot button

#### Scenario: Mock banner
- **WHEN** the booth is in Mock Poll
- **THEN** a persistent "MOCK POLL" banner is visible and counts are labelled as mock

### Requirement: Ballot button and lamps
The Master Terminal SHALL show a large Ballot button and two lamps: Ready (lit when a
ballot can be issued) and Busy (lit while a Ballot Session is pending). The Ballot
button SHALL be enabled only when the server state allows issuing. It SHALL be disabled
from the moment it is pressed until the server responds, and it SHALL show the reason
whenever it is disabled.

#### Scenario: Press Ballot
- **WHEN** the Presiding Officer presses Ballot while Ready is lit
- **THEN** the Busy lamp lights, the Ready lamp goes off, and the Ballot button is disabled

#### Scenario: Vote cast
- **WHEN** the voter casts the ballot
- **THEN** within 2 seconds the Busy lamp goes off, the count increases by one, and the Ready lamp lights

#### Scenario: Rapid double press
- **WHEN** the Presiding Officer presses Ballot twice in quick succession
- **THEN** only one Ballot Session request is sent

### Requirement: Cancel pending ballot
While a Ballot Session is pending, the Master Terminal SHALL offer a Cancel action that
requires choosing a reason and confirming.

#### Scenario: Cancel
- **WHEN** the Presiding Officer cancels a pending ballot with reason "voter left without voting"
- **THEN** the Busy lamp goes off, the cancelled count increases by one, and the Ready lamp lights

### Requirement: Mock poll controls
The Master Terminal SHALL let the Presiding Officer start a mock poll, cast test ballots
through the normal Ballot flow, view the current round's per-candidate mock counts, and
clear the mock poll after confirming. It SHALL also allow repeating the mock poll before
opening.

#### Scenario: View mock result
- **WHEN** the Presiding Officer opens "Mock result" after 3 test ballots
- **THEN** the Master Terminal shows per-post, per-candidate mock counts totalling 3 ballots

#### Scenario: Clear requires confirmation
- **WHEN** the Presiding Officer presses Clear mock poll
- **THEN** a confirmation shows the mock counts that will be recorded in the audit before the action is sent

### Requirement: Open and close confirmations
Opening the poll SHALL show a confirmation stating that the real count is 0, and SHALL
require re-authentication. Closing the poll SHALL show the current counts, require the
Presiding Officer to type CLOSE, and require re-authentication. Either action SHALL be
unavailable when the server state does not allow it, with the reason shown.

#### Scenario: Close confirmation
- **WHEN** the Presiding Officer chooses Close poll
- **THEN** the poll closes only after they type CLOSE and re-authenticate successfully

#### Scenario: Close while busy
- **WHEN** a Ballot Session is pending
- **THEN** Close poll is disabled with the reason "A ballot is pending: wait or cancel"

### Requirement: No real choices on the Master Terminal
The Master Terminal SHALL never show real per-candidate counts or any real voter's
choices.

#### Scenario: During open poll
- **WHEN** the booth is Open
- **THEN** the Master Terminal shows only ballots-cast and ballots-cancelled totals

### Requirement: Idle screen lock
The Master Terminal SHALL lock its screen after 5 minutes without interaction and SHALL
require the Presiding Officer's password to unlock. While locked, it SHALL keep showing
the booth state, counts and lamps, but no action SHALL be possible.

#### Scenario: Locked master
- **WHEN** the Master Terminal is locked
- **THEN** the Ballot button cannot be pressed until the Presiding Officer unlocks it
