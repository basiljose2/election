## Purpose

Lets the Returning Officer finish polling, declare final results once integrity is
proven, and present them as a clear, signed, exportable dashboard of votes polled and
winners.

## ADDED Requirements

### Requirement: Returning Officer polling dashboard
While the Election is Polling Open, the Returning Officer dashboard SHALL show, for each
booth:
- booth state
- Master Terminal and Voting Terminal online status
- ballots cast and ballots cancelled
- time of last activity

It SHALL also show election totals, refreshed within 10 seconds of any change. It
SHALL NOT show per-candidate counts.

#### Scenario: Live turnout
- **WHEN** a ballot is cast at Booth A
- **THEN** the RO dashboard shows Booth A's increased count within 10 seconds

### Requirement: Complete all polls checklist
The dashboard SHALL show a "Complete all polls" action with a checklist of booths not
yet Closed, and SHALL enable the action only when every booth is Closed. It SHALL offer
force-close for each Open booth.

#### Scenario: Checklist blocks completion
- **WHEN** one booth is still Open
- **THEN** "Complete all polls" is disabled and that booth is listed with a force-close option

### Requirement: Declaration preconditions
Declaring results SHALL require the Election to be Polling Completed, a fresh election
reconciliation run inside the declaration transaction, and recent re-authentication of
the Returning Officer. Declaring SHALL be possible only once per Election.

#### Scenario: Declare twice
- **WHEN** a Returning Officer requests declaration for an Election already in Results Declared
- **THEN** the system rejects the request

### Requirement: Winner computation
For each contested Post with N seats that passed reconciliation, the system SHALL rank
Candidates by real votes in descending order, excluding NOTA. Let V be the votes of the
Candidate ranked N-th.
- If no Candidate ranked below N has V votes, the top N Candidates SHALL be Elected.
- Otherwise, Candidates with more than V votes SHALL be Elected, the remaining seats
  SHALL be marked Tie, and every Candidate with exactly V votes SHALL be listed as tied
  for those seats. The system SHALL NOT break the tie.

#### Scenario: Clear winner, single seat
- **WHEN** a 1-seat Post has votes A = 50, B = 40
- **THEN** A is Elected

#### Scenario: Tie for a single seat
- **WHEN** a 1-seat Post has votes A = 45, B = 45, C = 10
- **THEN** no Candidate is Elected, the Post is marked Tie, and A and B are listed as tied for 1 seat

#### Scenario: Partial tie on a multi-seat post
- **WHEN** a 3-seat Post has votes A = 60, B = 50, C = 40, D = 40, E = 10
- **THEN** A and B are Elected, and C and D are listed as tied for the 1 remaining seat

#### Scenario: All votes NOTA
- **WHEN** every ballot chose NOTA for a 1-seat Post with Candidates A and B
- **THEN** A and B each have 0 votes and the Post is marked Tie

### Requirement: NOTA reporting
When NOTA is enabled, results SHALL report the NOTA count for each Post. NOTA SHALL
never be Elected. The Post SHALL be flagged "NOTA exceeded winner" when NOTA's count is
greater than the votes of any Elected Candidate of that Post.

#### Scenario: NOTA leads
- **WHEN** a 1-seat Post has NOTA = 70, A = 50, B = 30
- **THEN** A is Elected and the Post is flagged "NOTA exceeded winner"

### Requirement: Uncontested and withheld posts
Uncontested Posts SHALL show their Candidates as Elected unopposed. Posts that FAILED
reconciliation SHALL be shown as "Withheld – integrity check failed" with no counts,
while all other Posts are declared.

#### Scenario: Withheld post
- **WHEN** Post P failed reconciliation and Post Q passed
- **THEN** Post Q's results are declared and Post P is shown as withheld, with no counts

### Requirement: Immutable signed Result
Declaration SHALL, in one transaction:
- compute all Post results
- store them as an immutable Result snapshot, signed with the election key
- move the Election to Results Declared
- record an Audit Event with the Result hash

#### Scenario: Result cannot change
- **WHEN** any application database role attempts to update a stored Result
- **THEN** the database rejects the operation

### Requirement: Results dashboard
After declaration, the results dashboard SHALL show:
- election totals: ballots cast, ballots cancelled, number of booths
- for each Post: seats, each Candidate's votes and share of valid answers, NOTA count, Elected/Tie/Withheld/Unopposed status, and the margin between the last Elected Candidate and the next Candidate
- a bar chart per Post
- a booth-wise table of votes per Candidate per booth

#### Scenario: Winner highlighted
- **WHEN** the dashboard renders a declared Post
- **THEN** Elected Candidates are visually highlighted and the margin is shown

### Requirement: Result exports
The Returning Officer SHALL be able to export the declared Result as PDF, CSV and the
signed canonical JSON. Every export SHALL include the Result hash.

#### Scenario: Export PDF
- **WHEN** the Returning Officer exports the PDF
- **THEN** the PDF contains every Post's results and the Result hash
