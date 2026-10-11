## Purpose

Provides a tamper-evident, append-only record of every state-changing action so that
anyone can later check that the election was run as the rules require.

## ADDED Requirements

### Requirement: Every state change is audited
The system SHALL record an Audit Event for every state-changing action and every denied
authorization attempt. The Audit Event SHALL be written in the same database transaction
as the change it describes. Each Audit Event SHALL contain: election id, event type,
actor identity and role (or terminal id), target entity, state before and after, and
server timestamp.

#### Scenario: Change and audit are atomic
- **WHEN** a state change is committed
- **THEN** exactly one corresponding Audit Event exists

#### Scenario: Audit write fails
- **WHEN** the Audit Event cannot be written
- **THEN** the state change is rolled back and the caller receives an error

### Requirement: Audit Events never contain vote choices
Audit Events SHALL NOT contain any candidate or NOTA choice. They SHALL NOT contain any
identifier that links a Ballot Session to a Vote Selection.

#### Scenario: Ballot cast event
- **WHEN** a ballot is cast
- **THEN** the Audit Event records only the booth, the Ballot Session id and the fact of casting, and contains no choice data

### Requirement: Append-only enforcement
The database SHALL reject UPDATE, DELETE and TRUNCATE on Audit Events for every role
the application uses. It SHALL do so through both privileges and triggers.

#### Scenario: Application tries to edit an event
- **WHEN** any application database role issues an UPDATE or DELETE against an Audit Event
- **THEN** the database raises an error and the row is unchanged

### Requirement: Hash chain per election
Each Audit Event SHALL carry a per-election sequence number and a hash computed over
its canonical content and the previous event's hash. The first event of an Election
SHALL chain from a published genesis value.

#### Scenario: Verification succeeds
- **WHEN** a verifier recomputes the chain over an unmodified export
- **THEN** every hash matches and the sequence numbers have no gaps

#### Scenario: Tampering detected
- **WHEN** any exported event is altered, removed or reordered
- **THEN** verification reports the first mismatching sequence number

### Requirement: Audit export
The system SHALL export the Audit Event chain of an Election in a documented canonical
JSON format, together with a description of the hashing algorithm, so that third
parties can verify it independently.

#### Scenario: Export
- **WHEN** an authorized user requests the audit export for an Election
- **THEN** the system returns all events in sequence order as canonical JSON
