# Vote Selections: format, signatures and secrecy

## What is stored

One row of `vote_selections` per chosen option (one per Candidate, or one for NOTA):

| column         | meaning                                           |
| -------------- | ------------------------------------------------- |
| `id`           | random UUIDv4                                     |
| `election_id`  | the Election                                      |
| `booth_id`     | the Polling Booth                                 |
| `post_id`      | the Post                                          |
| `candidate_id` | the Candidate, or `null` for NOTA                 |
| `is_nota`      | `true` for NOTA                                   |
| `is_mock`      | `true` for a mock (test) ballot                   |
| `mock_round`   | the booth's mock poll round (mock rows only)      |
| `signature`    | Ed25519 signature, base64url (64 bytes, 86 chars) |

There is deliberately **no** timestamp, sequence number, session, terminal or staff reference.

## Signature

The signed bytes are the UTF-8 canonical JSON of exactly these fields (keys sorted, no
whitespace, `null` for absent values):

```json
{
  "booth_id": "…",
  "candidate_id": "… or null",
  "election_id": "…",
  "id": "…",
  "is_mock": false,
  "is_nota": false,
  "mock_round": null,
  "post_id": "…"
}
```

The public key is the 32-byte raw Ed25519 key, base64url, published in the frozen setup
(`signing.public_key` in `docs/SETUP_FORMAT.md`, so it is covered by the Setup Hash).
`src/lib/votes/signing.ts` is the reference implementation; its golden test vectors
(`signing.test.ts`) were produced independently with plain `node:crypto`.

## Who can read what

- The application database role can only `INSERT` Vote Selections. It cannot `SELECT`, `UPDATE`,
  `DELETE` or `TRUNCATE` them, and sees no statistics about them in the catalogue.
- Reads go through `SECURITY DEFINER` functions owned by the `vote_reader` role, which check the
  state themselves:
  - `mock_counts(booth, round)`: mock rows of the booth's current round only;
  - `booth_integrity_digest(booth)`: row count and digest, only once the booth is Closed;
  - `election_tally(election)`: per-candidate real counts, only once polling is completed.

## Residual risk (accepted, documented)

PostgreSQL stores rows in insertion order and keeps internal transaction ids. Someone with
**superuser access to the database** could therefore infer the order in which ballots were cast.
Mitigations in place: no timestamp or serial column; selections of one ballot are written in a
random order with random ids; exports and digests are sorted by random id. Operational control:
direct database access is limited to the Super Admin (see the runbook). Moving rows in
randomised batches when a booth closes is tracked as hardening work.

A leaked signing key lets an attacker forge rows that verify; they would still be caught by
reconciliation (the number of rows must match the booth's ballots-cast count). Each Election has
its own key, wrapped by `VOTE_SIGNING_MASTER_KEY`; use a different master key per environment and
rotate it per Election.
