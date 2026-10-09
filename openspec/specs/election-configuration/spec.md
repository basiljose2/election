## Purpose

Lets a Returning Officer define what is voted on and where (Election, Posts, Candidates,
Polling Booths and Booth-Post mapping), then freeze it into a fixed, publicly verifiable
Ballot Definition for each booth.

## Requirements

### Requirement: Multiple independent elections
The system SHALL support any number of Elections. Each has a name, a description, a
scheduled polling date and a NOTA setting. All Posts, Candidates, Polling Booths, votes
and results SHALL belong to exactly one Election and SHALL NOT be visible to or usable
by another.

#### Scenario: Create election
- **WHEN** a Super Admin creates an Election with a name, a polling date and NOTA enabled
- **THEN** the Election exists in the Draft state with NOTA enabled

#### Scenario: Isolation
- **WHEN** a Returning Officer of Election A lists Posts
- **THEN** no Post of Election B is returned

### Requirement: Posts with seats
A Post SHALL have a name, a display order and a number of seats N, where N is an
integer ≥ 1. Post names SHALL be unique within an Election.

#### Scenario: Invalid seats
- **WHEN** a Returning Officer saves a Post with seats = 0
- **THEN** the system rejects it with a validation error

### Requirement: Candidates
A Candidate SHALL belong to exactly one Post and have a name, an optional photo and an
optional symbol (image or short text). Candidate names SHALL be unique within a Post.
Photos and symbol images SHALL be PNG, JPEG or WebP, at most 2 MB, and the server SHALL
re-encode them.

#### Scenario: Oversized photo
- **WHEN** a Returning Officer uploads a 5 MB photo
- **THEN** the system rejects the upload

#### Scenario: Disguised file
- **WHEN** a Returning Officer uploads a file whose content is not a supported image, whatever its extension
- **THEN** the system rejects the upload

### Requirement: Polling Booths and Presiding Officers
A Polling Booth SHALL have a name and a location. Before freeze, each Polling Booth
SHALL have exactly one Presiding Officer assigned by a Super Admin.

#### Scenario: Booth without PO blocks freeze
- **WHEN** a Returning Officer attempts to freeze setup while any booth has no Presiding Officer
- **THEN** freeze is rejected and the booth is listed as a validation failure

### Requirement: Booth-Post mapping
The Returning Officer SHALL map each Polling Booth to one or more Posts. A booth's voters
SHALL be offered only the Posts mapped to that booth.

#### Scenario: Department-specific post
- **WHEN** Post "CS Department Representative" is mapped only to Booth "CS Block"
- **THEN** the Ballot Definition of Booth "Main Hall" does not include that Post

### Requirement: Editing only in Draft
Elections, Posts, Candidates, Polling Booths and Booth-Post mappings SHALL be editable
only while the Election is in the Draft state.

#### Scenario: Edit after freeze
- **WHEN** a Returning Officer attempts to rename a Candidate of a Frozen Election
- **THEN** the system rejects the change

### Requirement: Uncontested posts
When freeze succeeds, a Post whose number of Candidates equals its seats SHALL be marked
Uncontested. Uncontested Posts SHALL be excluded from every Ballot Definition, and their
Candidates SHALL be reported as elected unopposed in results.

#### Scenario: Two candidates for two seats
- **WHEN** setup is frozen with a Post of 2 seats and exactly 2 Candidates
- **THEN** the Post is marked Uncontested and appears on no ballot

### Requirement: Freeze validation
Freezing setup SHALL succeed only if all of the following hold, and otherwise SHALL
fail listing every violation:
- the Election has at least one Post
- every Post has at least as many Candidates as seats
- every contested Post is mapped to at least one Polling Booth
- every Polling Booth is mapped to at least one contested Post
- every Polling Booth has a Presiding Officer

Freezing is a critical action requiring recent re-authentication.

#### Scenario: Too few candidates
- **WHEN** a Post has 3 seats and 2 Candidates and the Returning Officer attempts to freeze
- **THEN** freeze fails naming that Post

#### Scenario: Several violations
- **WHEN** freeze is attempted with one booth lacking a PO and one post lacking a booth mapping
- **THEN** both violations are reported in a single response

#### Scenario: Successful freeze
- **WHEN** all validation rules pass and the Returning Officer confirms freeze
- **THEN** the Election moves to the Frozen state and an Audit Event records the Setup Hash

### Requirement: Ballot serial numbers
On freeze, the system SHALL assign each Candidate in a contested Post a ballot serial
number 1..k in the order the Returning Officer set. When NOTA is enabled, NOTA SHALL
appear after the last Candidate of every contested Post.

#### Scenario: Serial numbering
- **WHEN** a Post with Candidates ordered [Asha, Bilal, Chen] is frozen with NOTA enabled
- **THEN** the ballot shows 1 Asha, 2 Bilal, 3 Chen, then NOTA

### Requirement: Ballot Definition and Setup Hash
On freeze, the system SHALL produce, for each Polling Booth, an immutable Ballot
Definition: its contested Posts in display order, each with seats, Candidates in serial
order, and NOTA if enabled. The system SHALL compute a Setup Hash over the canonical
form of the whole frozen setup and make it available for public verification.

#### Scenario: Setup Hash is reproducible
- **WHEN** a verifier recomputes the Setup Hash from the published frozen setup
- **THEN** the result equals the Setup Hash recorded in the Audit Event

#### Scenario: Ballot Definition is immutable
- **WHEN** any application database role attempts to update or delete a Ballot Definition
- **THEN** the database rejects the operation

### Requirement: Unfreeze before any ballot
A Returning Officer SHALL be able to return a Frozen Election to Draft only if no Ballot
Session (mock or real) has ever been issued in that Election. Unfreezing SHALL be
audited, and a later freeze SHALL produce a new Setup Hash.

#### Scenario: Unfreeze after mock poll
- **WHEN** a mock Ballot Session has been issued at any booth and the Returning Officer requests unfreeze
- **THEN** the system rejects the request

### Requirement: Clone election for rehearsal
A Super Admin SHALL be able to clone an Election's setup into a new Draft Election. The
clone SHALL contain no Ballot Sessions, votes, terminals or results.

#### Scenario: Rehearsal copy
- **WHEN** a Super Admin clones a Frozen Election
- **THEN** a new Draft Election exists with identical Posts, Candidates, Polling Booths and mappings, and no ballots
