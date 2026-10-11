/**
 * Seeds a frozen e2e Election with a closed booth that holds real, signed Vote Selections and
 * a Booth Tally, so the results spec can run the real completion, reconciliation and
 * declaration. Local test stack only (TEST_ADMIN_DATABASE_URL); the votes are written with the
 * Election's own signing key, exactly as the casting path signs them.
 *
 *   tsx --conditions=react-server scripts/e2e-seed-results.ts <electionId> <closedBoothId>
 *
 * Plan (booth "closed"): 6 ballots.
 *   President (1 seat): c0 x2, c1 x1, NOTA x3        -> c0 elected, NOTA exceeds the winner
 *   Council (2 seats):  c0 x6, c1 x5, c2 x1
 */
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { Pool } from "pg";
import { loadElectionSigningKey, parseMasterKey } from "@/lib/votes/keys";
import { signSelection, type SelectionContent } from "@/lib/votes/signing";
import { createBoothTally } from "@/lib/votes/tally";
import { assertLocal } from "../tests/support/local-only";

config({ path: ".env.test.local", quiet: true });
config({ path: ".env.local", quiet: true });

async function main() {
  const [electionId, boothId] = process.argv.slice(2);
  if (!electionId || !boothId) throw new Error("usage: e2e-seed-results <electionId> <boothId>");
  const db = new Pool({
    connectionString: assertLocal("TEST_ADMIN_DATABASE_URL", process.env.TEST_ADMIN_DATABASE_URL),
    max: 1,
  });
  try {
    const masterKey = parseMasterKey(process.env.VOTE_SIGNING_MASTER_KEY);
    const { privateKey } = await loadElectionSigningKey(db, electionId, masterKey);

    const posts = await db.query<{ id: string; name: string }>(
      "select id, name from public.posts where election_id = $1",
      [electionId],
    );
    const postId = (name: string) => posts.rows.find((p) => p.name === name)!.id;
    const candidatesOf = async (id: string) =>
      (
        await db.query<{ id: string }>(
          "select id from public.candidates where post_id = $1 order by sort_order",
          [id],
        )
      ).rows.map((r) => r.id);
    const president = postId("President");
    const council = postId("Council");
    const [p0, p1] = await candidatesOf(president);
    const [c0, c1, c2] = await candidatesOf(council);

    type Pick = string | "nota";
    const ballots: Array<{ president: Pick; council: [string, string] }> = [
      { president: p0!, council: [c0!, c1!] },
      { president: p0!, council: [c0!, c1!] },
      { president: p1!, council: [c0!, c1!] },
      { president: "nota", council: [c0!, c1!] },
      { president: "nota", council: [c0!, c1!] },
      { president: "nota", council: [c0!, c2!] },
    ];

    const rows: SelectionContent[] = [];
    const add = (post: string, candidate: string | null) =>
      rows.push({
        id: randomUUID(),
        election_id: electionId,
        booth_id: boothId,
        post_id: post,
        candidate_id: candidate,
        is_nota: candidate === null,
        is_mock: false,
        mock_round: null,
      });
    for (const ballot of ballots) {
      add(president, ballot.president === "nota" ? null : ballot.president);
      for (const candidate of ballot.council) add(council, candidate);
    }
    for (const row of rows) {
      await db.query(
        `insert into public.vote_selections
           (id, election_id, booth_id, post_id, candidate_id, is_nota, is_mock, mock_round, signature)
         values ($1, $2, $3, $4, $5, $6, false, null, $7)`,
        [
          row.id,
          row.election_id,
          row.booth_id,
          row.post_id,
          row.candidate_id,
          row.is_nota,
          signSelection(privateKey, row),
        ],
      );
    }
    await db.query("update public.booth_counters set ballots_cast = $2 where booth_id = $1", [
      boothId,
      ballots.length,
    ]);

    // The booth walks its lifecycle to Closed, then its Booth Tally is created and signed.
    for (const state of ["mock_poll", "mock_cleared", "open", "closed"]) {
      await db.query("update public.booth_states set state = $2 where booth_id = $1", [
        boothId,
        state,
      ]);
    }
    await createBoothTally(db, { electionId, boothId, closedAt: new Date(), masterKey });
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
