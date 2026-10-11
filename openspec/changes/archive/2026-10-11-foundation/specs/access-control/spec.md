## Purpose

Controls who can do what in the election system: staff accounts, multi-factor
authentication, and roles scoped to a specific Election or Polling Booth.

## ADDED Requirements

### Requirement: Staff roles
The system SHALL support the roles Super Admin, Returning Officer, Presiding Officer and
Observer. A Returning Officer assignment SHALL be scoped to exactly one Election. A
Presiding Officer assignment SHALL be scoped to exactly one Polling Booth. An Observer
assignment SHALL be scoped to one Election.

#### Scenario: PO acts on own booth
- **WHEN** a Presiding Officer requests an action on the Polling Booth they are assigned to
- **THEN** the system evaluates the action against that booth's lifecycle rules

#### Scenario: PO acts on another booth
- **WHEN** a Presiding Officer requests any action on a Polling Booth they are not assigned to
- **THEN** the system rejects the request with an authorization error and records an Audit Event of the denied attempt

#### Scenario: RO acts on another election
- **WHEN** a Returning Officer requests any action on an Election they are not assigned to
- **THEN** the system rejects the request

### Requirement: Only Super Admin manages staff and assignments
The system SHALL allow only a Super Admin to create staff accounts, deactivate them, and
assign or unassign roles.

#### Scenario: RO attempts to assign a role
- **WHEN** a Returning Officer attempts to assign a Presiding Officer to a Polling Booth
- **THEN** the system rejects the request

#### Scenario: Deactivated account
- **WHEN** a deactivated staff account attempts to sign in or use an existing session
- **THEN** the system rejects the request and invalidates the session

### Requirement: Mandatory MFA for privileged roles
Super Admin and Returning Officer accounts SHALL complete TOTP multi-factor
authentication on every sign-in before accessing any privileged function.

#### Scenario: RO without completed MFA
- **WHEN** a Returning Officer signs in with a correct password but has not completed the TOTP challenge
- **THEN** the system denies access to all Returning Officer functions

#### Scenario: MFA enrolment required
- **WHEN** a Super Admin or Returning Officer without an enrolled TOTP factor signs in
- **THEN** the system requires enrolment before granting any access

### Requirement: Re-authentication for critical actions
The system SHALL require the acting user to have re-entered their password (and TOTP
code for privileged roles) within the last 5 minutes before a critical action. Critical
actions are: freezing setup, opening a poll, closing a poll, completing all polls, and
declaring results.

#### Scenario: Stale authentication
- **WHEN** a Presiding Officer requests to close a poll and last re-authenticated more than 5 minutes ago
- **THEN** the system requires re-authentication and does not close the poll until it succeeds

### Requirement: Server-side authorization of all mutations
Every state-changing request SHALL be authorized on the server using the caller's
authenticated identity, role and scope. The system SHALL NOT rely on client-side checks.
Browser clients SHALL have no direct write access to any database table.

#### Scenario: Direct database write from a browser
- **WHEN** a browser client uses the public database key to insert, update or delete a row in any table
- **THEN** the database rejects the operation

### Requirement: Session security
Staff sessions SHALL use HttpOnly, Secure, SameSite cookies. Sessions SHALL expire after
30 minutes of inactivity. Presiding Officer sessions on a paired Master Terminal SHALL
instead expire after 12 hours. Failed sign-in attempts SHALL be rate limited.

#### Scenario: Idle staff session
- **WHEN** a Returning Officer session has had no activity for 30 minutes
- **THEN** the next request is rejected and the user must sign in again

#### Scenario: Brute force
- **WHEN** more than 5 failed sign-in attempts for one account occur within 15 minutes
- **THEN** the system blocks further attempts for that account for 15 minutes and records an Audit Event
