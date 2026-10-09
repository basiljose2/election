# Frozen setup format

When a Returning Officer freezes an Election, the system stores the exact canonical JSON text
that was hashed (`setup_snapshots.canonical_json`) and one Ballot Definition per booth
(`ballot_definitions.canonical_json`). Both are append-only.

- **Setup Hash** = SHA-256 (lowercase hex) of the UTF-8 bytes of `canonical_json`.
- **Canonical JSON** = the same rules as the audit log (`docs/AUDIT_FORMAT.md`): keys sorted,
  no whitespace, integers only.
- The freeze Audit Event (`election.frozen`) records `after.setup_hash`.
- Each Ballot Definition embeds `setup_hash`; its own hash is `definition_hash`.
- `freeze_number` is part of the hashed content, so a freeze after an unfreeze always has a new hash.
- Public copy: `GET /api/elections/<id>/setup` returns `{ setup_hash, canonical_json, freeze_no }`
  for a Frozen Election. Verify with: `sha256(canonical_json) == setup_hash`.

Contents: election settings, Posts (with `uncontested`), Candidates (with `serial` 1..k for
contested Posts, content hashes of photo and symbol images), booths and their Booth-Post mapping.
Candidate images are content-addressed WebP files in the `candidate-media` Storage bucket
(created on first upload; public read, server-only write).
