## Context

Vote Selections are unreadable by the application role. All checks run inside the
`vote_reader` SECURITY DEFINER functions from `ballot-casting-core`, which return only
totals, booleans and hashes.

## Goals / Non-Goals

**Goals:**
- Detect any change to stored votes after close
- Detect forged rows and setup drift

**Non-Goals:**
- Automatic repair (a failure withholds results for the affected Posts; see `results-dashboard`)

## Decisions

- **Merkle tree.** Leaves are `SHA-256(canonical_selection_json || signature)` sorted by
  selection id. Internal nodes are `SHA-256(0x01 || left || right)`, leaves are prefixed
  with `0x00`, and an odd last node is promoted. This is the same algorithm as the
  public verifier (`transparency-portal`), shared as a package with test vectors.
- **Answer rule without revealing NOTA.** The digest function computes
  `answers = candidate_rows / N + nota_rows` inside SQL and returns only `answers` and a
  divisibility flag, never the split.
- **Tally signing.** The Booth Tally is signed with the election Ed25519 key over
  canonical JSON. The tally hash is `SHA-256(canonical_tally_json)`.
- **Close hook.** Implemented as an `onTransition(Open → Closed)` hook, so a tally
  always exists for every Closed booth, including force-closed booths.
- **Election reconciliation.** Runs when the Returning Officer opens the declare screen
  and again inside the declare transaction. Runtime is linear in the number of
  selections, which at campus scale (≤ 50k rows) takes a few seconds, well within
  function limits. If this ever exceeds limits, per-booth checks can run as a queue of
  smaller jobs.

## Secrecy and integrity

Only totals, flags and hashes leave the database. The Merkle root commits to the full
set of stored rows without revealing them until publication after declaration.

## Risks / Trade-offs

- [Closing a large booth is slow because the digest runs in the close transaction] → A few thousand rows per booth hashes in milliseconds in Postgres (pgcrypto).
- [A FAILED tally has no remedy] → Intended. Failures are made visible, never silently fixed. The runbook describes the escalation (for example, a re-poll for the affected Post, handled outside the system).
