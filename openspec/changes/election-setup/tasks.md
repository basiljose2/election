## 1. Data model

- [ ] 1.1 Migrations for elections (nota_enabled, status, polling_date), posts (seats ≥ 1, display_order), candidates (post_id, sort order), booths, booth_posts, with unique and check constraints; verify SQL tests reject seats = 0 and a duplicate candidate name
- [ ] 1.2 Draft-only triggers on posts, candidates, booths and booth_posts; verify an SQL test shows an edit on a Frozen election is rejected (negative test)
- [ ] 1.3 Append-only `ballot_definitions` and `setup_snapshots` tables; verify UPDATE and DELETE are rejected (negative test)

## 2. Commands and admin UI

- [ ] 2.1 Election create/edit/list commands (Super Admin creates, RO edits own); verify an RO cannot edit another election (negative test)
- [ ] 2.2 Post CRUD with ordering and seats; verify with unit and e2e tests
- [ ] 2.3 Candidate CRUD with drag ordering; verify the order persists in e2e
- [ ] 2.4 Candidate photo and symbol upload: magic-byte check, 2 MB limit, WebP re-encode, content-hash naming; verify oversized and disguised uploads are rejected
- [ ] 2.5 Booth CRUD and a Booth-Post mapping matrix UI; verify the mapping persists and is scoped to the election
- [ ] 2.6 Clone-election command; verify the clone has identical setup and no ballots

## 3. Freeze and unfreeze

- [ ] 3.1 Freeze validation reporting all violations at once; verify a unit test per rule and one multi-violation test
- [ ] 3.2 Uncontested detection (candidates = seats); verify such a post is excluded from every Ballot Definition
- [ ] 3.3 Serial assignment, NOTA placement and per-booth Ballot Definition snapshots; verify snapshot content for a two-booth fixture with a booth-specific post
- [ ] 3.4 Setup Hash computation, recorded in the freeze Audit Event; verify it is reproducible from the published canonical JSON
- [ ] 3.5 Freeze requires re-authentication; verify stale auth is rejected
- [ ] 3.6 Unfreeze allowed only when no Ballot Session has ever existed; verify rejection after a mock session (negative test using a fixture row)
