/**
 * Post-restore verification. Point it at the RESTORED database (never at production) and it
 * proves the restore is faithful for a declared Election:
 *
 *   1. the election reconciliation passes (every booth, Post and election-wide check);
 *   2. both audit hash chains verify end to end;
 *   3. a verification bundle regenerated from the restored rows passes the independent
 *      verifier, and carries the same Result hash as the live Result.
 *
 *   RESTORE_DATABASE_URL=postgres://... tsx --conditions=react-server \
 *     scripts/ops/verify-restore.ts --election <uuid> [--allow-remote]
 *
 * Read-only: it writes nothing to the database. Exit code 0 only if everything passes.
 */
import { config } from "dotenv";
import { Pool } from "pg";
import { buildAuditExport } from "@/lib/audit/export";
import { verifyAuditChain } from "@/lib/audit/verify";
import { runReconciliation } from "@/lib/reconciliation/run";
import { bundleFiles, loadBundleInput, zipFiles } from "@/lib/transparency/bundle";
import { readZip } from "../../tools/verifier/lib/zip.mjs";
import { verifyBundle } from "../../tools/verifier/lib/bundle.mjs";
import { assertLocal } from "../../tests/support/local-only";

config({ path: ".env.test.local", quiet: true });

const arg = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

async function main(): Promise<number> {
  const url = process.env.RESTORE_DATABASE_URL;
  const electionId = arg("election");
  if (!url || !electionId) {
    console.error(
      "usage: RESTORE_DATABASE_URL=... verify-restore.ts --election <uuid> [--allow-remote]",
    );
    return 2;
  }
  if (!process.argv.includes("--allow-remote")) assertLocal("RESTORE_DATABASE_URL", url);

  const db = new Pool({ connectionString: url, max: 2 });
  let ok = true;
  const line = (pass: boolean, text: string) => {
    ok &&= pass;
    console.log(`${pass ? "PASS" : "FAIL"}  ${text}`);
  };
  try {
    const election = await db.query<{ status: string }>(
      "select status::text status from public.elections where id = $1",
      [electionId],
    );
    if (!election.rows[0]) {
      console.error("FAIL  the election is not in the restored database");
      return 1;
    }
    line(
      ["results_declared", "archived"].includes(election.rows[0].status),
      `election status is ${election.rows[0].status}`,
    );

    const report = await runReconciliation(db, { electionId, now: new Date() });
    const failedElection = report.electionChecks.filter((c) => !c.passed);
    line(
      failedElection.length === 0,
      `election-wide checks (${report.electionChecks.map((c) => c.check).join(", ")})`,
    );
    for (const c of failedElection) console.log(`        ${c.check}: ${c.detail ?? ""}`);
    const failedBooths = report.booths.filter((b) => !b.passed);
    line(
      failedBooths.length === 0,
      `${report.booths.length} booth(s) reconcile with their Booth Tallies`,
    );
    for (const b of failedBooths) {
      for (const c of b.checks.filter((x) => !x.passed)) {
        console.log(`        ${b.boothName}: ${c.check} ${c.detail ?? ""}`);
      }
    }

    for (const chain of [electionId, null]) {
      const verification = verifyAuditChain(await buildAuditExport(db, chain));
      line(
        verification.ok,
        `audit chain ${chain ?? "system"}: ${
          verification.ok
            ? `${verification.eventCount} events`
            : `${verification.reason} at ${verification.seq}`
        }`,
      );
    }

    const input = await loadBundleInput(db, electionId);
    const files = await readZip(new Uint8Array(zipFiles(bundleFiles(input))));
    const verdict = await verifyBundle(files);
    line(
      verdict.ok,
      `verifier on a bundle rebuilt from the restored rows (${verdict.checks.length} checks)`,
    );
    for (const c of verdict.checks.filter((x: { status: string }) => x.status === "fail")) {
      console.log(`        ${c.id}: ${c.detail}`);
    }
    line(
      verdict.resultHash === input.result.resultHash,
      `Result hash ${input.result.resultHash.slice(0, 16)}…`,
    );
  } finally {
    await db.end();
  }
  console.log(ok ? "\nRESTORE VERIFIED" : "\nRESTORE NOT VERIFIED");
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
