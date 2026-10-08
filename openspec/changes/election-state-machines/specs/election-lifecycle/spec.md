## Purpose

Defines the only permitted states and transitions of an Election and of each Polling
Booth, so that every action (enabling a ballot, test voting, closing, declaring) is
allowed only at the right moment.

## ADDED Requirements

### Requirement: Election states
An Election SHALL be in exactly one of: Draft, Frozen, Polling Open, Polling Completed,
Results Declared, Archived. The only permitted transitions SHALL be:
- Draft → Frozen (freeze) and Frozen → Draft (unfreeze), as defined by election configuration
- Frozen → Polling Open (start polling), by the Returning Officer
- Polling Open → Polling Completed (complete all polls), by the Returning Officer
- Polling Completed → Results Declared (declare results), by the Returning Officer
- Results Declared → Archived, by a Super Admin

Any other transition SHALL be rejected.

#### Scenario: Skip a state
- **WHEN** a Returning Officer requests to declare results for an Election in Polling Open
- **THEN** the system rejects the request

#### Scenario: Go backwards
- **WHEN** anyone requests to move a Polling Completed Election back to Polling Open
- **THEN** the system rejects the request

### Requirement: Booth states
A Polling Booth SHALL be in exactly one of: Setup, Mock Poll, Mock Cleared, Open, Closed,
Sealed. The only permitted transitions SHALL be:
- Setup → Mock Poll (start mock poll), by the booth's Presiding Officer
- Mock Poll → Mock Cleared (clear mock poll), by the Presiding Officer
- Mock Cleared → Mock Poll (repeat mock poll), by the Presiding Officer
- Mock Cleared → Open (open poll), by the Presiding Officer
- Open → Closed (close poll), by the Presiding Officer, or by the Returning Officer (force close)
- Closed → Sealed, as part of completing all polls

A Closed or Sealed booth SHALL never return to Open.

#### Scenario: Reopen attempt
- **WHEN** a Presiding Officer requests to open a Closed booth
- **THEN** the system rejects the request

### Requirement: Start mock poll guard
Starting a mock poll SHALL require the Election to be Frozen or Polling Open, and the
booth to have an active Master Terminal and an active Voting Terminal.

#### Scenario: No voting terminal
- **WHEN** a Presiding Officer starts a mock poll with no Voting Terminal paired
- **THEN** the system rejects the request

### Requirement: Clear mock poll guard
Clearing a mock poll SHALL require at least one mock ballot to have been cast in the
current mock poll and no pending Ballot Session. Clearing SHALL record the mock poll's
per-candidate counts in the Audit Event, and those mock votes SHALL then be excluded
from every count.

#### Scenario: Clear without testing
- **WHEN** a Presiding Officer tries to clear a mock poll in which no mock ballot was cast
- **THEN** the system rejects the request

#### Scenario: Mock counts preserved in audit
- **WHEN** a mock poll with 3 test ballots is cleared
- **THEN** the Audit Event contains the mock per-candidate counts and the booth's real count is 0

### Requirement: Open poll guard
Opening a poll SHALL require:
- the Election is Polling Open
- the booth is Mock Cleared
- no pending Ballot Session exists
- zero real ballots have been cast at the booth
- the Voting Terminal is online
- the Presiding Officer re-authenticated within the last 5 minutes

#### Scenario: Open before polling day starts
- **WHEN** a Presiding Officer requests to open the booth while the Election is still Frozen
- **THEN** the system rejects the request

#### Scenario: Open with terminal offline
- **WHEN** the Voting Terminal is offline and the Presiding Officer requests to open the poll
- **THEN** the system rejects the request

### Requirement: Close poll guard
Closing a poll SHALL require no pending Ballot Session and recent re-authentication.
Closing SHALL be irreversible.

#### Scenario: Close with pending ballot
- **WHEN** a Ballot Session is pending and the Presiding Officer requests to close the poll
- **THEN** the system rejects the request and asks the Presiding Officer to wait for the vote or cancel the ballot

### Requirement: Force close by Returning Officer
The Returning Officer SHALL be able to close an Open booth of their Election, with a
mandatory written reason and recent re-authentication. A pending Ballot Session at that
booth SHALL be cancelled in the same transaction.

#### Scenario: Unreachable PO
- **WHEN** the Returning Officer force-closes Booth A with reason "PO unwell"
- **THEN** Booth A becomes Closed, any pending Ballot Session is cancelled, and the Audit Event contains the reason

### Requirement: Complete all polls guard
Completing all polls SHALL require every booth of the Election to be Closed, and recent
re-authentication by the Returning Officer. It SHALL move every booth to Sealed and the
Election to Polling Completed in one transaction.

#### Scenario: A booth still open
- **WHEN** the Returning Officer requests to complete all polls while Booth B is Open
- **THEN** the system rejects the request and names Booth B

### Requirement: Transitions are atomic and audited
Every transition SHALL be validated and applied on the server in one transaction,
together with its Audit Event and a booth state version increment. Concurrent
conflicting transitions SHALL result in exactly one success.

#### Scenario: Double click on open
- **WHEN** two identical open-poll requests for the same booth arrive at the same time
- **THEN** exactly one succeeds and the other is rejected as an invalid transition
