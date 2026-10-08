## Purpose

Guarantees that a stored vote cannot be traced to a voter or to other choices on the
same ballot, cannot be altered or removed, and cannot be counted by anyone before
results are declared, while remaining verifiable by the public afterwards.

## ADDED Requirements

### Requirement: Vote Selection content
Each stored Vote Selection SHALL contain only: a random identifier, the Election, the
Polling Booth, the Post, the chosen Candidate or NOTA, the mock flag and mock round (for
mock only), and a signature. It SHALL NOT contain or reference a Ballot Session, a
terminal, a staff member, a timestamp, a sequence number, or any other Vote Selection.

#### Scenario: Stored row inspection
- **WHEN** an auditor inspects any stored Vote Selection
- **THEN** it has no field from which the Ballot Session, the casting time or the order of casting can be derived

### Requirement: Choices on one ballot are unlinkable
Vote Selections from the same ballot, whether for different Posts or for the N seats of
one Post, SHALL NOT share any identifier or value that links them together.

#### Scenario: Two posts on one ballot
- **WHEN** a voter chooses Candidate X for Post 1 and Candidate Y for Post 2
- **THEN** the two stored Vote Selections have independent random identifiers and nothing else that pairs them

### Requirement: No vote choices in logs, audit or signals
Vote choices SHALL NOT appear in application logs, error reports, Audit Events,
signals, analytics or any storage other than the Vote Selection store.

#### Scenario: Cast error logging
- **WHEN** a cast request fails validation and the error is logged
- **THEN** the log entry contains the error code and booth but not the submitted choices

### Requirement: Append-only Vote Selections
The database SHALL reject UPDATE, DELETE and TRUNCATE on Vote Selections and on Ballot
Sessions in a terminal state (Cast or Cancelled), for every application role.

#### Scenario: Attempt to change a vote
- **WHEN** any application database role issues an UPDATE on a Vote Selection
- **THEN** the database raises an error and the row is unchanged

### Requirement: Signed Vote Selections
Each Vote Selection SHALL be signed by the server with an election signing key over its
canonical content. The corresponding public verification key SHALL be published. A
Vote Selection with an invalid signature SHALL fail verification.

#### Scenario: Forged row
- **WHEN** a Vote Selection is inserted into the database without passing through the cast process
- **THEN** its signature does not verify with the published key and reconciliation reports it

### Requirement: Per-candidate counts sealed until declaration
No user, role or API SHALL be able to obtain per-candidate real vote counts, or read
real Vote Selections, before the Election reaches Polling Completed. Per-candidate real
counts SHALL first become visible through result declaration. Totals of ballots cast
and cancelled per booth are not sealed.

#### Scenario: RO tries to peek
- **WHEN** a Returning Officer requests per-candidate counts while the Election is Polling Open
- **THEN** the system rejects the request

#### Scenario: Application role tries to read votes
- **WHEN** the application's database role runs a SELECT directly on the real Vote Selections while polling is open
- **THEN** the database denies the query

### Requirement: Voting Terminal retains nothing
The Voting Terminal SHALL keep the voter's choices only in memory during the Ballot
Session, SHALL NOT write them to any browser storage, and SHALL discard them once the
cast succeeds or the session is cancelled.

#### Scenario: After casting
- **WHEN** a ballot has been cast and the terminal is locked
- **THEN** no previous choice can be recovered from the terminal's page state or browser storage
