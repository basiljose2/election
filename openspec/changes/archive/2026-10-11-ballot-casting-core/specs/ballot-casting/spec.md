## Purpose

Lets a Presiding Officer enable exactly one ballot at a time on the booth's Voting
Terminal, and records that ballot exactly once, atomically, for every contested Post
mapped to the booth.

## ADDED Requirements

### Requirement: Issue a Ballot Session
The system SHALL issue a Ballot Session only when all of the following hold:
- the request comes from the booth's active Master Terminal with the booth's Presiding Officer signed in
- the booth is Open (real ballot) or in Mock Poll (mock ballot)
- the booth's Voting Terminal is online
- no other Ballot Session is pending at the booth

The Ballot Session SHALL be bound to the booth's current Voting Terminal and SHALL be
marked mock if and only if the booth is in Mock Poll.

#### Scenario: Enable a ballot
- **WHEN** the Presiding Officer presses Ballot at an Open booth with the Voting Terminal online and nothing pending
- **THEN** a pending real Ballot Session is created, an Audit Event is recorded, and the Voting Terminal is signalled

#### Scenario: Second ballot while one is pending
- **WHEN** the Presiding Officer presses Ballot while a Ballot Session is pending
- **THEN** the system rejects the request

#### Scenario: Booth not open
- **WHEN** the Presiding Officer presses Ballot at a booth in Mock Cleared
- **THEN** the system rejects the request

### Requirement: Only the bound Voting Terminal receives the ballot
Only the Voting Terminal bound to a pending Ballot Session SHALL receive that booth's
Ballot Definition and a single-use cast token for the session.

#### Scenario: Other device requests ballot
- **WHEN** any device other than the bound Voting Terminal requests the pending ballot
- **THEN** the system rejects the request

### Requirement: Ballot validation
A cast request SHALL contain exactly one answer for every contested Post in the booth's
Ballot Definition and no other Posts. For each Post with N seats, the answer SHALL be
either exactly N distinct Candidates of that Post, or (only if NOTA is enabled for the
Election) NOTA alone. An invalid cast request SHALL be rejected entirely, store nothing,
and leave the Ballot Session pending.

#### Scenario: Single-seat post
- **WHEN** a ballot selects 1 Candidate for a 1-seat Post
- **THEN** the answer is valid

#### Scenario: Multi-seat post, too few
- **WHEN** a ballot selects 2 Candidates for a 3-seat Post
- **THEN** the cast is rejected and nothing is stored

#### Scenario: Duplicate candidate
- **WHEN** a ballot selects the same Candidate twice for a 2-seat Post
- **THEN** the cast is rejected

#### Scenario: NOTA mixed with candidates
- **WHEN** a ballot selects NOTA and one Candidate for the same Post
- **THEN** the cast is rejected

#### Scenario: NOTA disabled
- **WHEN** a ballot selects NOTA in an Election where NOTA is disabled
- **THEN** the cast is rejected

#### Scenario: Post skipped
- **WHEN** a ballot omits one of the booth's contested Posts
- **THEN** the cast is rejected

#### Scenario: Post from another booth
- **WHEN** a ballot includes a Post that is not mapped to the booth
- **THEN** the cast is rejected

### Requirement: Atomic, exactly-once casting
A valid cast SHALL do all of the following in one transaction, or none of them:
- store the Vote Selections for all Posts
- mark the Ballot Session Cast
- increment the booth's ballots-cast count (or mock count)
- record an Audit Event

A Ballot Session SHALL be cast at most once.

#### Scenario: Failure mid-way
- **WHEN** storing any Vote Selection fails during a cast
- **THEN** no Vote Selection is stored, the Ballot Session remains pending, and the count is unchanged

#### Scenario: Double tap
- **WHEN** two cast requests for the same Ballot Session arrive at the same time
- **THEN** exactly one ballot is stored

### Requirement: Idempotent retries
Each cast request SHALL carry an idempotency key generated when the voter confirms. A
repeated request with the same key for an already-cast session SHALL return the
original success without storing anything. A request with a different key for an
already-cast or cancelled session SHALL be rejected.

#### Scenario: Network retry
- **WHEN** the Voting Terminal loses the response to a successful cast and retries with the same idempotency key
- **THEN** it receives success and the booth count increases only once

### Requirement: Cast response carries no choices
The response to a cast SHALL confirm only that the ballot was recorded. No response or
signal to any terminal SHALL echo the choices.

#### Scenario: Successful cast response
- **WHEN** a ballot is cast
- **THEN** the response contains only a success status

### Requirement: Cancel a pending Ballot Session
The Presiding Officer SHALL be able to cancel a pending Ballot Session with a reason
chosen from a fixed list (voter left without voting, voter refused to vote, terminal
fault) plus optional text. Cancelling SHALL store no Vote Selection, SHALL increment the
booth's ballots-cancelled count, SHALL be audited, and SHALL lock the Voting Terminal.
A pending Ballot Session SHALL also be cancelled automatically when the booth is
force-closed.

#### Scenario: Voter walks away
- **WHEN** the Presiding Officer cancels a pending Ballot Session with reason "voter left without voting"
- **THEN** the Voting Terminal locks, no vote is stored, and the ballots-cancelled count increases by one

#### Scenario: Cast after cancel
- **WHEN** the Voting Terminal submits a cast for a cancelled Ballot Session
- **THEN** the system rejects it and stores nothing

### Requirement: Mock ballots
During Mock Poll, ballots SHALL follow exactly the same issue, validation and cast rules
and SHALL be stored flagged as mock with the mock poll round number. Mock Vote
Selections SHALL never be included in any real count, reconciliation total or result.
The Presiding Officer SHALL be able to view per-candidate mock counts for the current
mock poll round.

#### Scenario: Mock result display
- **WHEN** 3 mock ballots have been cast in the current mock poll round
- **THEN** the Presiding Officer can see the per-candidate mock counts for those 3 ballots

#### Scenario: Mock excluded from real totals
- **WHEN** a booth that cast 3 mock ballots opens its poll and then casts 10 real ballots
- **THEN** its ballots-cast count is 10 and results include only those 10

### Requirement: Booth counters visible live
The booth's ballots-cast and ballots-cancelled counts SHALL be updated in the cast or
cancel transaction and SHALL be readable by the booth's Master Terminal, the Returning
Officer, Observers and the public status board.

#### Scenario: Live turnout
- **WHEN** a ballot is cast at Booth A
- **THEN** the next state fetch by Booth A's Master Terminal shows the count increased by one
