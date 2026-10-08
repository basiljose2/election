## Purpose

Binds physical devices to a Polling Booth as its Master Terminal or Voting Terminal, so
that only the registered devices of a booth can take part in that booth's poll.

## ADDED Requirements

### Requirement: Master Terminal registration
A Presiding Officer SHALL be able to register the device they are signed in on as the
Master Terminal of their assigned Polling Booth. A booth SHALL have at most one active
Master Terminal. Registering a new Master Terminal SHALL revoke the previous one.

#### Scenario: Register master
- **WHEN** the Presiding Officer of Booth A registers their device as Master Terminal
- **THEN** the device receives a Master Terminal credential bound to Booth A and an Audit Event is recorded

#### Scenario: Replace master
- **WHEN** a second device is registered as Master Terminal for Booth A
- **THEN** the first device's credential is revoked and its next request is rejected

### Requirement: Voting Terminal pairing by one-time code
A Voting Terminal SHALL be paired only through a one-time pairing code generated on the
booth's Master Terminal. The code SHALL be 6 digits (also offered as a QR code), valid
for 2 minutes, single-use, and allow at most 5 attempts. After the code is entered, the
Master Terminal SHALL show the device's short identifier, and the Presiding Officer
SHALL confirm it before pairing completes.

#### Scenario: Successful pairing
- **WHEN** a kiosk device enters a valid code and the Presiding Officer confirms the displayed device identifier
- **THEN** the device becomes the Voting Terminal of that booth and receives a Voting Terminal credential

#### Scenario: Expired code
- **WHEN** a device enters a code older than 2 minutes
- **THEN** pairing is rejected

#### Scenario: Code guessing
- **WHEN** 5 wrong codes have been submitted against a booth's active code
- **THEN** the code is invalidated, further attempts are rejected, and an Audit Event is recorded

#### Scenario: Unconfirmed pairing
- **WHEN** a device enters a valid code but the Presiding Officer rejects or does not confirm it within 2 minutes
- **THEN** no credential is issued

### Requirement: One Voting Terminal per booth
A Polling Booth SHALL have at most one active Voting Terminal. Pairing a replacement
SHALL revoke the previous Voting Terminal. Replacement SHALL NOT be allowed while a
Ballot Session is pending at that booth.

#### Scenario: Replace during pending ballot
- **WHEN** a Ballot Session is pending and the Presiding Officer starts pairing a new Voting Terminal
- **THEN** the system rejects pairing until the pending Ballot Session is cast or cancelled

### Requirement: Terminal credentials
Terminal credentials SHALL be random, stored on the device only as HttpOnly, Secure,
SameSite=Strict cookies, and stored on the server only as hashes. Every terminal request
SHALL be checked against an active credential, the bound booth and the terminal type. All
terminal credentials of a booth SHALL be revoked automatically when the booth is Sealed.

#### Scenario: Voting Terminal calls a master-only action
- **WHEN** a request carrying a Voting Terminal credential attempts to issue a Ballot Session
- **THEN** the system rejects it and records an Audit Event

#### Scenario: Credential used at another booth
- **WHEN** a terminal credential of Booth A is used on a request for Booth B
- **THEN** the system rejects it

#### Scenario: Booth sealed
- **WHEN** Booth A is Sealed
- **THEN** every terminal credential of Booth A is rejected from then on

### Requirement: Pairing is allowed only before the booth closes
Terminals SHALL be registrable only while the Election is Frozen or Polling Open and the
booth has not been Closed.

#### Scenario: Pair after close
- **WHEN** a Presiding Officer attempts to pair a Voting Terminal at a Closed booth
- **THEN** the system rejects the request
