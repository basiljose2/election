## Purpose

Lets anyone (students, candidates, agents, auditors) see what is on the ballot, watch
polling progress, and after declaration independently verify and recount the entire
election without trusting the server.

## ADDED Requirements

### Requirement: Public election page
Once an Election is Frozen, a public page without login SHALL show its Posts with seats,
Candidates in serial order with photos and symbols, NOTA status, Polling Booths, the
Posts each booth votes on, the Setup Hash and the public signing key. Draft Elections
SHALL NOT be public.

#### Scenario: Draft election
- **WHEN** someone opens the public page of a Draft Election
- **THEN** the system responds as if it does not exist

#### Scenario: Frozen election
- **WHEN** someone opens the public page of a Frozen Election
- **THEN** they see every Ballot Definition and the Setup Hash

### Requirement: Public live status board
While polling, the public status board SHALL show each booth's state and its ballots-cast
and ballots-cancelled counts, with data no more than 15 seconds old, and the election
totals. It SHALL NOT show per-candidate data or staff identities.

#### Scenario: Turnout visible
- **WHEN** ballots are being cast at Booth A
- **THEN** the public board shows Booth A's count, at most 15 seconds old

### Requirement: Published Booth Tallies
Each Booth Tally SHALL become publicly visible as soon as its booth closes, including
its tally hash, Merkle root, signature and PASS/FAILED status.

#### Scenario: Agent cross-checks
- **WHEN** an agent compares the tally hash they recorded from the Master Terminal with the public Booth Tally
- **THEN** the hashes match

### Requirement: Public results
After declaration, a public results page SHALL show the declared Result exactly as
signed, including booth-wise figures and the Result hash.

#### Scenario: Results before declaration
- **WHEN** someone requests the public results of an Election in Polling Completed
- **THEN** no per-candidate data is returned

### Requirement: Verification bundle
After declaration, anyone SHALL be able to download a verification bundle containing:
- the frozen setup and Ballot Definitions
- the public key
- the full audit chain export
- all Booth Tallies
- every real Vote Selection per booth, sorted by identifier, with its signature
- the signed Result
- a README describing every format and algorithm

Audit Events in the bundle SHALL contain no data beyond what the audit log already
holds (no vote choices).

#### Scenario: Download bundle
- **WHEN** someone downloads the bundle for a declared Election
- **THEN** it contains every listed item, and the Vote Selections carry no session, terminal, time or ordering data

### Requirement: Independent verifier
The project SHALL provide a verifier, as a static in-browser page and a command-line
tool, that takes a verification bundle and checks:
- the Setup Hash
- the audit chain
- every signature
- each booth's Merkle root and count against its Booth Tally
- the ballot-answer rule
- a full recount equal to the Result's counts
- the winner rules, including ties

It SHALL report PASS or the first failure for each check.

#### Scenario: Honest bundle
- **WHEN** the verifier runs on an unmodified bundle
- **THEN** every check reports PASS and the recount equals the declared Result

#### Scenario: Altered vote
- **WHEN** one Vote Selection in the bundle is changed to another Candidate
- **THEN** the verifier reports a signature failure and a Merkle root mismatch for that booth

### Requirement: Observer view
Authenticated Observers SHALL be able to see a live feed of the Election's Audit Events
(which never contain choices) and the reconciliation report.

#### Scenario: Observer sees booth opening
- **WHEN** a Presiding Officer opens Booth A
- **THEN** the Observer feed shows the open event within 15 seconds

### Requirement: Public endpoints are protected against abuse
Public pages and downloads SHALL be served from cached, read-only data. They SHALL be
rate limited per client and SHALL NOT expose any write endpoint.

#### Scenario: Flood of requests
- **WHEN** a single client sends more than 60 requests per minute to public endpoints
- **THEN** further requests from that client are refused for the rest of the minute, and polling is unaffected
