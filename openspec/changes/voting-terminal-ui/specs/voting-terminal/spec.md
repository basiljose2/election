## Purpose

Provides the voter-facing EVM Ballot Unit: a full-screen kiosk that stays locked until
the Presiding Officer enables it, guides the voter through every Post on their ballot,
records the vote with a long beep, and locks again.

## ADDED Requirements

### Requirement: Activation
After pairing, the Voting Terminal SHALL require a one-time Activate tap (performed by
the Presiding Officer) that enters fullscreen and enables audio. Until it is activated,
the terminal SHALL show "Not activated" and SHALL NOT display a ballot even if one is
enabled.

#### Scenario: Activate
- **WHEN** the Presiding Officer taps Activate on a paired Voting Terminal
- **THEN** the terminal enters fullscreen, plays a short test tone, and shows the locked screen

### Requirement: Locked by default
The Voting Terminal SHALL show a locked screen ("Please wait for the Presiding Officer")
whenever no Ballot Session is pending for it, including after page reload, reconnect or
restart.

#### Scenario: Reload while locked
- **WHEN** the Voting Terminal page is reloaded with no pending Ballot Session
- **THEN** it shows the locked screen

### Requirement: Ballot display
When a Ballot Session is pending, the Voting Terminal SHALL show within 1 second (with
real-time available) the first contested Post of the booth's Ballot Definition. Each
Post screen SHALL show:
- the Post name
- the instruction "Select exactly N" (or "Select 1")
- progress (for example "Post 2 of 4")
- each Candidate in serial order, with serial number, photo, name, symbol, a large select button and a lamp
- NOTA last, if enabled

#### Scenario: Unlock on enable
- **WHEN** the Presiding Officer presses Ballot
- **THEN** the Voting Terminal shows the first Post within 1 second

### Requirement: Selection rules
For a Post with N seats, the voter SHALL be able to select up to N distinct Candidates,
with each selected Candidate's lamp lit.
- For N = 1, selecting another Candidate SHALL move the selection.
- For N > 1, selecting beyond N SHALL be refused with the message "You have already selected N. Deselect one to change."
- Selecting NOTA SHALL clear any selected Candidates for that Post, and selecting a Candidate SHALL clear NOTA.
- The Next button SHALL be enabled only when exactly N Candidates, or NOTA alone, are selected.

#### Scenario: Multi-seat post
- **WHEN** a Post has 3 seats and the voter has selected 2 Candidates
- **THEN** the Next button is disabled and the screen shows "Select 1 more"

#### Scenario: Switch to NOTA
- **WHEN** the voter has selected 2 Candidates and then selects NOTA
- **THEN** both Candidate lamps go off, the NOTA lamp lights, and Next is enabled

### Requirement: Review and confirm
After the last Post, the Voting Terminal SHALL show a review screen listing every Post
with the chosen Candidate names (or NOTA). Each Post SHALL have a Change action that
returns to that Post. A single "Cast my vote" button SHALL submit the whole ballot.

#### Scenario: Change from review
- **WHEN** the voter presses Change next to Post 2 on the review screen
- **THEN** Post 2 is shown with the current selections, and after Next the voter returns to the review screen

### Requirement: Casting feedback and beep
On pressing "Cast my vote", the Voting Terminal SHALL immediately disable input and show
"Recording your vote…". It SHALL retry with the same idempotency key until it receives
a definitive answer. On success it SHALL play one continuous beep of about 2 seconds,
show "Your vote has been recorded" for 3 seconds, clear all choices from memory, and
return to the locked screen. It SHALL NOT beep on any other outcome.

#### Scenario: Successful cast
- **WHEN** the cast succeeds
- **THEN** a single long beep plays and the terminal locks within 5 seconds

#### Scenario: Temporary network loss during cast
- **WHEN** the cast request fails with a network error
- **THEN** the terminal keeps showing "Recording your vote…" and retries with the same idempotency key until it gets an answer

#### Scenario: Ballot cancelled while voting
- **WHEN** the Presiding Officer cancels the Ballot Session while the voter is on a Post screen
- **THEN** the terminal discards the choices, does not beep, and shows the locked screen

### Requirement: Kiosk protections
While activated, the Voting Terminal SHALL:
- suppress the context menu, text selection, pinch-zoom and browser back navigation
- contain no links or navigation to any other page
- show a blocking overlay with a "Return to full screen" button if fullscreen is exited
- never write choices to any browser storage

#### Scenario: Fullscreen exited mid-ballot
- **WHEN** fullscreen is exited while a ballot is displayed
- **THEN** the ballot is hidden behind a blocking overlay until fullscreen is restored, and the choices are kept in memory

### Requirement: Usability
Touch targets SHALL be at least 64 px tall. Text SHALL meet WCAG AA contrast. The
ballot SHALL be fully operable by touch, by mouse, and by keyboard (Tab, Enter and
arrow keys).

#### Scenario: Keyboard voting
- **WHEN** a voter uses only the keyboard
- **THEN** they can select Candidates, move between Posts, review and cast
