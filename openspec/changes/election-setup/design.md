## Context

This builds on the `foundation` command gateway and audit log. Elections are small (tens
of Posts, hundreds of Candidates, tens of booths), so neither performance nor paging is
a concern here.

## Goals / Non-Goals

**Goals:**
- A frozen, immutable, hash-identified definition of every booth's ballot

**Non-Goals:**
- States after Frozen
- Bulk CSV import (can be added later)

## Decisions

- **Snapshot on freeze.** Freeze writes one `ballot_definitions` row per booth holding a
  canonical JSON snapshot, plus a `setup_snapshots` row with the Setup Hash.
  - Terminals and vote validation read only the snapshot, never the live candidate
    tables. A later bug that edited candidate rows therefore could not change a ballot.
  - Snapshot tables are append-only, with the same enforcement as `audit_events`.
- **Draft-only edits in the database.** Triggers on posts, candidates, booths and
  booth_posts reject changes when the parent Election is not Draft. This is defence in
  depth on top of the command checks.
- **Candidate media.**
  - Images go in Supabase Storage (public bucket, since candidate images are public
    information). Uploads go through a server command only.
  - Files are validated by magic bytes, re-encoded to WebP on the server (sharp), and
    stored under content-addressed names.
  - The snapshot references each image's content hash, so an image swap after freeze
    is detectable.
- **Setup Hash.** SHA-256 over canonical JSON of {election settings, posts, candidates
  with serials and image hashes, booths, mappings, uncontested flags}.
- **Presiding Officer assignment.** Uses the `foundation` `staff_roles` mechanism. This
  change only adds the "every booth has a PO" freeze check.

## Secrecy and integrity

This change stores no votes. For integrity, the Ballot Definition is immutable and
hash-identified, and `ballot-casting-core` validates every Vote Selection against it.

## Risks / Trade-offs

- [The RO finds a typo after a mock poll has started] → Unfreeze is blocked by design. The runbook says to rehearse on a cloned election first.
- [Public image bucket] → Candidate images are public anyway. Nobody can upload except through the server command.
