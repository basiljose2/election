## Context

This is the critical path. It needs Ballot Definitions (`election-setup`), terminals and
signals (`realtime-device-pairing`) and the transition engine
(`election-state-machines`). Every decision below favours secrecy and integrity over
convenience.

## Goals / Non-Goals

**Goals:**
- Exactly-once casting
- Unlinkable, unordered, signed Vote Selections
- Counts sealed until polls are complete

**Non-Goals:**
- Booth Tally and Merkle root (`booth-close-reconciliation`)
- End-to-end cryptographic voter verifiability, meaning receipts a voter could check.
  Receipts would let a voter prove their vote to someone else, which enables coercion
  and vote buying, so they're deliberately excluded.

## Decisions

- **Tables.**
  - `ballot_sessions`: id, booth_id, terminal_id, is_mock, mock_round, status
    (Issued/Cast/Cancelled), cast_token_hash, idempotency_key_hash, issued_by,
    issued_at, finished_at, cancel_reason.
  - `vote_selections`: id (UUIDv4), election_id, booth_id, post_id, candidate_id NULL,
    is_nota, is_mock, mock_round NULL, signature. Deliberately no timestamps and no
    serial id.
  - `booth_counters`: booth_id, ballots_cast, ballots_cancelled, mock_cast_by_round.
- **Cast transaction.**
  1. `SELECT ... FOR UPDATE` the session and require status = Issued.
  2. Validate the answers against the Ballot Definition snapshot.
  3. Insert the selections.
  4. Set status = Cast.
  5. Increment the counter.
  6. Write the audit event, bump the state version, commit.
  7. Publish the ballot-cast signal after the commit.

  The idempotency key hash is stored on the session, so a retry with the same key
  returns the stored success.
- **Sealing counts with grants.**
  - `app_server` has INSERT only on `vote_selections`; no SELECT.
  - Reads happen only through `SECURITY DEFINER` functions owned by a separate
    `vote_reader` role:
    - `mock_counts(booth, round)`: allowed for mock rows only.
    - `booth_integrity_digest(booth)`: allowed once the booth is Closed; returns row
      count, signature check and Merkle root, but no per-candidate counts.
    - `election_tally(election)`: raises unless the Election is Polling Completed or
      later.
  - The functions check state themselves, so a bug in the app layer cannot unseal
    counts.
- **Signatures.**
  - Ed25519 signature over canonical JSON {id, election_id, booth_id, post_id,
    candidate_id|NOTA, is_mock, mock_round}.
  - One key pair per election is generated at freeze. The private key is encrypted
    with a master key held in a Vercel env var (envelope encryption) and stored in the
    database. The public key is published with the Setup Hash.
  - Ed25519 was chosen over HMAC so anyone can verify signatures without a secret.
- **Randomising physical order.** Postgres stores rows in insertion order, so an
  administrator with raw database access could learn the order in which votes were
  cast. Mitigations:
  - (a) no timestamp or serial columns
  - (b) all exports and digests are sorted by random id
  - (c) raw database access is restricted to the Super Admin, as documented in the
    runbook
  - (d) optional hardening: selections are first written to an unlogged holding
    table and moved in randomised batches when the booth closes

  Option (d) is deferred to `hardening` because it complicates the atomic count. The
  residual risk is documented.
- **Log redaction.** A single logger wrapper drops request bodies for `/api/terminal/*`.
  A CI lint rule forbids `console.*` in the casting modules. Sentry (if used) has body
  scrubbing enabled.
- **Mock rounds.** `mock_round` increments each time the booth enters Mock Poll.
  Clearing records the counts of the current round in the Audit Event. Mock rows
  remain stored, flagged, and are excluded from every real query by a mandatory
  `is_mock = false` predicate inside the reader functions.

## Secrecy and integrity

This change defines both. See the specs for the observable guarantees and the decisions
above for how they are enforced.

## Risks / Trade-offs

- [Physical insertion order reveals voting order to a database superuser] → Restricted access and no timestamps; randomised batch moving is an optional hardening item.
- [Signing key compromise lets an attacker forge valid-looking rows] → Such rows would still break reconciliation (count mismatch against ballots cast). The key is envelope-encrypted and the master key is rotated per election.
- [A voter takes too long] → No expiry; the PO can cancel. This mirrors EVM practice.
- [Vercel function timeout during cast] → The transaction is small (at most tens of rows). The idempotent retry covers lost responses.
