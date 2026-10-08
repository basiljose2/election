## Purpose

Produces a signed, fixed account of each Polling Booth's votes at close, and verifies
before results are declared that the stored votes, signatures, setup and audit chain
all still match.

## ADDED Requirements

### Requirement: Booth Tally at close
Closing a booth SHALL, in the same transaction, create an immutable Booth Tally
containing:
- Election, booth, and the close time
- ballots cast, ballots cancelled, and the number of mock rounds held
- for each contested Post mapped to the booth, the number of ballot answers (candidate selections ÷ N, plus NOTA selections)
- the count of real Vote Selections
- a Merkle root over the booth's real Vote Selections, sorted by identifier
- a server signature over all of the above

The Booth Tally SHALL NOT contain per-candidate or NOTA counts.

#### Scenario: Close creates tally
- **WHEN** the Presiding Officer closes Booth A after 120 ballots with 2 cancelled
- **THEN** a signed Booth Tally exists showing 120 cast, 2 cancelled, and 120 answers for each mapped contested Post

#### Scenario: Tally has no candidate counts
- **WHEN** anyone views a Booth Tally before results are declared
- **THEN** it shows no per-candidate or NOTA counts

### Requirement: Close-time consistency checks
At close, the system SHALL check that for every mapped contested Post:
- the number of candidate selections is divisible by N
- the ballot answers equal the ballots cast
- no real Vote Selection exists for an unmapped Post
- every real Vote Selection's signature is valid

The booth SHALL still close if a check fails, but the Booth Tally SHALL be marked
FAILED with the failing checks listed, and the Returning Officer SHALL be alerted on
their dashboard.

#### Scenario: Mismatch at close
- **WHEN** a booth closes and Post P has 119 answers but 120 ballots cast
- **THEN** the Booth Tally is marked FAILED naming Post P and the Returning Officer sees an alert

### Requirement: Booth Tally on the Master Terminal
After closing, the Master Terminal SHALL display the Booth Tally, a short form of its
hash, and a QR code encoding the full hash. It SHALL offer a printable version.

#### Scenario: Agents record the tally
- **WHEN** the booth is closed
- **THEN** the Master Terminal shows the counts, the tally hash and its QR code

### Requirement: Election reconciliation before declaration
Before results can be declared, the system SHALL run an election reconciliation that
checks:
- each booth's Vote Selections still produce the same count and Merkle root as its Booth Tally
- all Booth Tally signatures and all Vote Selection signatures are valid
- the ballot-answer rule holds for every booth and Post
- the audit hash chain is valid
- the Setup Hash and every Ballot Definition are unchanged
- no Ballot Session is pending

The result of each check SHALL be recorded in an Audit Event.

#### Scenario: Post-close tampering
- **WHEN** a Vote Selection is added to Booth A's store after Booth A closed
- **THEN** the election reconciliation reports that Booth A's count and Merkle root no longer match its Booth Tally

#### Scenario: Clean election
- **WHEN** no data has changed since the booths closed
- **THEN** every check passes and the report shows PASS for every booth and Post

### Requirement: Reconciliation outcome per Post
The reconciliation SHALL mark each contested Post as PASS if every check passes for
every booth mapped to it and for the election-wide checks, and otherwise as FAILED.
The system SHALL provide `reconciliationPassed(post)` for result declaration.

#### Scenario: One booth fails
- **WHEN** Booth A fails and Post P is mapped to Booth A and Booth B, while Post Q is mapped only to Booth B
- **THEN** Post P is FAILED and Post Q is PASS

### Requirement: Reconciliation report visibility
The Returning Officer and Observers of the Election SHALL be able to view the
reconciliation report: for each booth, ballots cast and cancelled, answers per Post,
tally hash, and pass/fail for each check. The report SHALL NOT contain per-candidate
counts.

#### Scenario: Observer views report
- **WHEN** an Observer opens the reconciliation report after all polls are completed
- **THEN** they see every booth's checks and totals, and no per-candidate counts
