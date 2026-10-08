## Why

Before polling day, a Returning Officer must define exactly what is on the ballot and
where it is voted on: the Election, its Posts and seats, its Candidates, its Polling
Booths, and which Posts each booth votes on. Once polling starts, this definition must
be fixed and publicly checkable.

Depends on: `foundation`.

## What Changes

- Election CRUD with a per-election NOTA switch
- Posts with display order and `seats` (N ≥ 1)
- Candidates per Post, with name, optional photo and symbol, and a ballot serial number
- Polling Booths, and assignment of a Presiding Officer to each booth (by Super Admin)
- Booth-Post mapping: each booth votes only on its mapped Posts
- Freeze setup: validation, generating each booth's Ballot Definition, and publishing a Setup Hash
- Unfreeze, allowed only before any Ballot Session exists
- A "clone election" helper so the setup can be rehearsed on a copy

## Capabilities

### New Capabilities
- `election-configuration`: defining Elections, Posts, Candidates, Polling Booths, Booth-Post mapping, and freezing them into immutable per-booth Ballot Definitions

### Modified Capabilities
- none

## Non-goals

- Polling-day states after freeze (`election-state-machines`)
- Terminal pairing (`realtime-device-pairing`)
- Voter rolls

## Impact

- New tables: elections, posts, candidates, booths, booth_posts, ballot_definitions, setup_snapshots; candidate image storage
- Admin console screens for Super Admin and Returning Officer
