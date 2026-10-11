/**
 * After a load run: close every booth, create and sign each Booth Tally, and run the election
 * reconciliation. Prints PASS or the failing checks; exit code 0 only on PASS.
 *
 *   tsx --conditions=react-server scripts/load/finish.ts [load.json]
 */
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { Pool } from "pg";
import { runReconciliation } from "@/lib/reconciliation/run";
import { parseMasterKey } from "@/lib/votes/keys";
import { createBoothTally } from "@/lib/votes/tally";
import { assertLocal } from "../../tests/support/local-only";

config({ path: ".env.test.local", quiet: true });
config({ path: ".env.local", quiet: true });

async function main() {
  const file = process.argv[2] ?? "load.json";
  const load = JSON.parse(readFileSync(file, "utf8")) as {
    electionId: string;
    booths: Array<{ boothId: string }>;
  };
  const db = new Pool({
    connectionString: assertLocal("TEST_ADMIN_DATABASE_URL", process.env.TEST_ADMIN_DATABASE_URL),
    max: 2,
  });
  try {
    const masterKey = parseMasterKey(process.env.VOTE_SIGNING_MASTER_KEY);
    for (const { boothId } of load.booths) {
      await db.query("update public.booth_states set state = 'closed' where booth_id = $1", [
        boothId,
      ]);
      await createBoothTally(db, {
        electionId: load.electionId,
        boothId,
        closedAt: new Date(),
        masterKey,
      });
    }
    const report = await runReconciliation(db, { electionId: load.electionId, now: new Date() });

    const failedBooths = report.booths.filter((b) => !b.passed);
    const failedElection = report.electionChecks.filter((c) => !c.passed);
    console.log(
      `Reconciliation: ${report.booths.length} booths, ${report.posts.length} Posts, ` +
        `${report.booths.reduce((s, b) => s + b.ballotsCast, 0)} ballots`,
    );
    if (failedBooths.length === 0 && failedElection.length === 0) {
      console.log("PASS: every booth, Post and election-wide check passed");
      return 0;
    }
    for (const c of failedElection) console.log(`FAIL election: ${c.check} ${c.detail ?? ""}`);
    for (const b of failedBooths) {
      for (const c of b.checks.filter((x) => !x.passed)) {
        console.log(`FAIL ${b.boothName}: ${c.check} ${c.detail ?? ""}`);
      }
    }
    return 1;
  } finally {
    await db.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
