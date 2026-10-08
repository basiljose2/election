## Purpose

Keeps a booth's Master Terminal and Voting Terminal in step within about a second, using
private signals that carry no vote content, while the database remains the only source
of truth.

## ADDED Requirements

### Requirement: Private per-booth channel
Each Polling Booth SHALL have a private signalling channel. Only that booth's active
Master Terminal and Voting Terminal SHALL be able to subscribe to it or receive its
messages. Only the server SHALL be able to publish to it.

#### Scenario: Foreign subscriber
- **WHEN** a client without an active credential for Booth A tries to subscribe to Booth A's channel
- **THEN** the subscription is refused

#### Scenario: Terminal tries to publish
- **WHEN** a paired terminal attempts to publish a message on its own booth channel
- **THEN** the message is rejected and not delivered

### Requirement: Signals carry no vote content
Signals SHALL contain only a signal type (for example ballot-enabled, ballot-cancelled,
ballot-cast, booth-state-changed, terminal-revoked) and a state version number. Signals
SHALL NOT contain any candidate or NOTA choice or ballot content.

#### Scenario: Ballot cast signal
- **WHEN** a ballot is cast at Booth A
- **THEN** the Master Terminal receives a ballot-cast signal with no choice data

### Requirement: Database is the source of truth
Terminals SHALL treat signals as hints only. On every signal, on reconnect and on page
load, a terminal SHALL fetch its authoritative state from the server. The terminal
state response SHALL include the booth state, whether a Ballot Session is pending for
this booth, the ballots-cast count (Master Terminal only), and a state version number.

#### Scenario: Forged or replayed signal
- **WHEN** a Voting Terminal receives a ballot-enabled signal but the server state shows no pending Ballot Session
- **THEN** the Voting Terminal stays locked

#### Scenario: Missed signal
- **WHEN** a Voting Terminal was disconnected while a ballot was enabled and then reconnects
- **THEN** it fetches state, finds the pending Ballot Session, and shows the ballot

### Requirement: Fallback polling
When the real-time connection is unavailable, a terminal SHALL poll its state endpoint
every 2 seconds until the connection is restored.

#### Scenario: Realtime outage
- **WHEN** the real-time service is unreachable and the PO enables a ballot
- **THEN** the Voting Terminal unlocks within 3 seconds through polling

### Requirement: Heartbeat and online status
Each paired terminal SHALL send a heartbeat every 10 seconds. The server SHALL consider
a terminal offline when no heartbeat has arrived for 30 seconds. The Master Terminal
SHALL show the Voting Terminal as online or offline and the time of its last heartbeat.

#### Scenario: Voting Terminal loses network
- **WHEN** the Voting Terminal sends no heartbeat for 30 seconds
- **THEN** the Master Terminal shows it as offline

### Requirement: Channel access tokens are short-lived
Credentials used to subscribe to a signalling channel SHALL be minted by the server for
one booth channel, expire within 15 minutes, and be refreshed using the terminal
credential.

#### Scenario: Revoked terminal refresh
- **WHEN** a revoked terminal requests a new channel token
- **THEN** the request is rejected and the terminal shows an unpaired screen
