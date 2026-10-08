## Purpose

Defines the performance, recoverability, monitoring and operating-procedure guarantees
the system must meet before it is used for a real election.

## ADDED Requirements

### Requirement: Polling-day performance
With 50 booths each casting one ballot every 10 seconds, each ballot covering 5 Posts,
for 60 minutes, the system SHALL keep the 95th-percentile cast latency below 1.5
seconds, record every ballot exactly once, and have zero failed casts after retries.

#### Scenario: Load test
- **WHEN** the load test runs against a production-like deployment
- **THEN** p95 cast latency is below 1.5 s, stored ballots equal issued-and-cast sessions, and reconciliation passes

### Requirement: Public load isolation
Public traffic SHALL NOT degrade voting. With 500 concurrent public viewers during the
load test, cast latency SHALL still meet the performance requirement.

#### Scenario: Results rush
- **WHEN** 500 simulated public clients poll the status board during the load test
- **THEN** the p95 cast latency remains below 1.5 s

### Requirement: Backup and restore
Point-in-time recovery SHALL be enabled for the production database. A restore drill
SHALL be performed before each real election, and the restored database SHALL pass
full election reconciliation and audit-chain verification.

#### Scenario: Restore drill
- **WHEN** the database is restored to a point after a rehearsal election's declaration
- **THEN** the verifier reports PASS on a bundle regenerated from the restored data

### Requirement: Monitoring without vote data
The system SHALL alert the Super Admin on server errors, database errors, failed
reconciliation and terminal-offline events during polling. No alert, log or monitoring
payload SHALL contain vote choices.

#### Scenario: Error alert
- **WHEN** a cast request fails with a server error during polling
- **THEN** the Super Admin receives an alert containing the booth and error code but no choices

### Requirement: Security verification
Before the first real election:
- an OWASP ASVS Level 2 checklist SHALL be completed with no open high-severity item
- the dependency audit SHALL show no known high or critical vulnerability
- penetration tests SHALL confirm that every negative test in the specs holds against the deployed system

#### Scenario: Release gate
- **WHEN** a production release is prepared for a real election
- **THEN** the checklist, audit report and penetration-test report are attached to the release, all passing

### Requirement: Operating procedures
The project SHALL include:
- a kiosk configuration guide
- a pre-poll checklist (rehearsal via cloned election, terminal pairing, backup hotspot, key generation, mock poll)
- a polling-day incident runbook covering Voting Terminal failure, Master Terminal failure, network outage, power loss, and an unreachable Presiding Officer
- a post-poll archiving procedure

#### Scenario: Terminal fails mid-poll
- **WHEN** a Presiding Officer follows the runbook for a failed Voting Terminal
- **THEN** the runbook's steps (cancel any pending ballot, pair a replacement, continue) restore voting without losing or duplicating any ballot

### Requirement: Dress rehearsal
Before the first real election, a full rehearsal election with at least 3 booths,
multi-seat Posts, a booth-specific Post and NOTA enabled SHALL be run on the production
deployment from setup to declaration. The verifier SHALL report PASS on its bundle.

#### Scenario: Rehearsal passes
- **WHEN** the rehearsal election is declared
- **THEN** the verifier reports PASS and the results match the rehearsal script's expected counts
