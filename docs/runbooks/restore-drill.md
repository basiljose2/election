# Backup and restore drill

**Requirement:** Point-in-time recovery (PITR) is enabled on the production database, and a
restore drill is done before each real election. The restored database must pass the full
election reconciliation and audit-chain verification, and the verifier must pass on a bundle
rebuilt from it.

## Enable PITR (SA, once)

1. Supabase dashboard → the production project → **Database → Backups** → enable
   **Point in Time Recovery** (needs a plan that includes it; PITR also requires the compute
   add-on of your plan tier).
2. Note the retention window (days) in the release record.
3. Confirm in the same screen that daily backups are listed.

## The drill (do on a rehearsal election, not on the real one)

1. Run a complete rehearsal election to declaration (`dress-rehearsal.md`). Record the time
   of declaration `T`, the election id and the Result hash.
2. In the dashboard choose **Restore to a new project** (never over production) at a time
   shortly **after** `T`. Wait for it to finish; note the restored project's database URL.
3. Run the verification **against the restored database**, from a trusted machine:

   ```
   RESTORE_DATABASE_URL="postgres://postgres:<password>@<restored-host>:5432/postgres" \
   npx tsx --conditions=react-server scripts/ops/verify-restore.ts \
       --election <election-id> --allow-remote
   ```

   It is read-only. It checks, in order: the election is in Results Declared; the election
   reconciliation passes (every booth, Post and election-wide check); both audit hash chains
   verify; a bundle rebuilt from the restored rows passes the independent verifier and has the
   Result hash you recorded.

4. The drill passes only if the last line is `RESTORE VERIFIED`. Attach the output.
5. Delete the restored project.

## Record

| Date    | Rehearsal election | Restored to (time) | Result hash | Output attached | By  |
| ------- | ------------------ | ------------------ | ----------- | --------------- | --- |
| _to do_ |                    |                    |             |                 |     |

## If a real restore is ever needed

1. Stop the application (set the Vercel project to maintenance) so nothing writes.
2. Restore to the last good time; run `verify-restore.ts` for every declared election.
3. Check booth counts in the restored database against the booths' printed Booth Tallies
   (hash and counts). Anything cast after the restore point was **lost with the restore**:
   list the affected booths and handle them under the RO's decision, outside the system.
4. Point the application at the restored database and resume.
