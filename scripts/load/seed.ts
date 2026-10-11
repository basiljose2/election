/**
 * Seeds a load-test election: N booths, each voting on the same P Posts, really frozen and
 * Polling Open, with a registered Master and Voting Terminal per booth (credentials known to
 * the load runner). Local or dedicated test stack only (TEST_ADMIN_DATABASE_URL).
 *
 *   tsx --conditions=react-server scripts/load/seed.ts [--booths 50] [--posts 5] [--out load.json]
 */
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { config } from "dotenv";
import { Pool } from "pg";
import { appendAuditEvent } from "@/lib/audit/append";
import { freezeSetup } from "@/lib/commands/freeze";
import { withTransaction } from "@/lib/db/pool";
import { hashCredential } from "@/lib/terminals/credentials";
import { assertLocal } from "../../tests/support/local-only";

config({ path: ".env.test.local", quiet: true });
config({ path: ".env.local", quiet: true });

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1]! : fallback;
};

async function main() {
  const boothCount = Number(arg("booths", "50"));
  const postCount = Number(arg("posts", "5"));
  const out = arg("out", "load.json");
  const db = new Pool({
    connectionString: assertLocal("TEST_ADMIN_DATABASE_URL", process.env.TEST_ADMIN_DATABASE_URL),
    max: 2,
  });
  try {
    const electionId = randomUUID();
    await db.query(
      "insert into public.elections (id, name, polling_date, nota_enabled) values ($1, $2, current_date, true)",
      [electionId, `Load test ${new Date().toISOString()}`],
    );

    const posts: Array<{ id: string; seats: number; candidates: string[] }> = [];
    for (let p = 0; p < postCount; p++) {
      const id = randomUUID();
      // Post 0 is a 2-seat Post so multi-seat answers are part of the load.
      const seats = p === 0 ? 2 : 1;
      await db.query(
        "insert into public.posts (id, election_id, name, display_order, seats) values ($1, $2, $3, $4, $5)",
        [id, electionId, `Post ${p + 1}`, p, seats],
      );
      const candidates: string[] = [];
      for (let c = 0; c < 4; c++) {
        const candidateId = randomUUID();
        candidates.push(candidateId);
        await db.query(
          "insert into public.candidates (id, election_id, post_id, name, sort_order) values ($1, $2, $3, $4, $5)",
          [candidateId, electionId, id, `Post ${p + 1} candidate ${c}`, c],
        );
      }
      posts.push({ id, seats, candidates });
    }

    const officer = randomUUID();
    await db.query(
      "insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')",
      [officer, `${officer}@load.test`],
    );
    await db.query(
      "insert into public.staff (user_id, email, display_name) values ($1, $2, 'Load officer')",
      [officer, `${officer}@load.test`],
    );
    await db.query(
      "insert into public.staff_roles (user_id, role, election_id) values ($1, 'returning_officer', $2)",
      [officer, electionId],
    );

    const booths: Array<{
      boothId: string;
      terminalId: string;
      votingToken: string;
    }> = [];
    for (let b = 0; b < boothCount; b++) {
      const boothId = randomUUID();
      await db.query(
        "insert into public.booths (id, election_id, name, location) values ($1, $2, $3, 'Load')",
        [boothId, electionId, `Booth ${String(b + 1).padStart(2, "0")}`],
      );
      for (const post of posts) {
        await db.query(
          "insert into public.booth_posts (election_id, booth_id, post_id) values ($1, $2, $3)",
          [electionId, boothId, post.id],
        );
      }
      const po = randomUUID();
      await db.query(
        "insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')",
        [po, `${po}@load.test`],
      );
      await db.query(
        "insert into public.staff (user_id, email, display_name) values ($1, $2, 'Load PO')",
        [po, `${po}@load.test`],
      );
      await db.query(
        "insert into public.staff_roles (user_id, role, election_id, booth_id) values ($1, 'presiding_officer', $2, $3)",
        [po, electionId, boothId],
      );
      booths.push({ boothId, terminalId: "", votingToken: "" });
    }

    // The real freeze (Ballot Definitions, Setup Hash, signing key).
    const input = freezeSetup.input.parse({ electionId });
    const grant = {
      id: randomUUID(),
      role: "returning_officer" as const,
      electionId,
      boothId: null,
    };
    await withTransaction(db, async (tx) => {
      const ctx = {
        tx,
        actor: {
          userId: officer,
          sessionId: randomUUID(),
          email: `${officer}@load.test`,
          displayName: "Load officer",
          roles: [grant],
          aal: "aal2" as const,
          authTimes: { password: null, totp: null },
        },
        grant,
        now: () => new Date(),
        onCommit: () => {},
        onRollback: () => {},
      };
      await freezeSetup.validate?.(ctx, input);
      const outcome = await freezeSetup.execute(ctx, input);
      await appendAuditEvent(tx, {
        electionId,
        eventType: freezeSetup.name,
        actor: { user_id: officer, role: "returning_officer", terminal_id: null },
        target: outcome.audit.target,
        before: outcome.audit.before,
        after: outcome.audit.after,
        detail: outcome.audit.detail ?? null,
      });
    });
    await db.query("update public.elections set status = 'polling_open' where id = $1", [
      electionId,
    ]);

    for (const booth of booths) {
      for (const type of ["master", "voting"] as const) {
        const token = randomBytes(32).toString("base64url");
        const { rows } = await db.query<{ id: string }>(
          `insert into public.terminals (election_id, booth_id, type, credential_hash, device_id)
           values ($1, $2, $3, $4, $5) returning id`,
          [
            electionId,
            booth.boothId,
            type,
            hashCredential(token),
            type === "voting" ? "LD01" : null,
          ],
        );
        if (type === "voting") {
          booth.terminalId = rows[0]!.id;
          booth.votingToken = token;
          await db.query(
            "insert into public.terminal_heartbeats (terminal_id, last_seen_at) values ($1, now())",
            [rows[0]!.id],
          );
        }
      }
      for (const state of ["mock_poll", "mock_cleared", "open"]) {
        await db.query("update public.booth_states set state = $2 where booth_id = $1", [
          booth.boothId,
          state,
        ]);
      }
    }

    writeFileSync(out, JSON.stringify({ electionId, officer, posts, booths }, null, 2));
    console.log(`Seeded ${boothCount} booths x ${postCount} Posts: ${out}`);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
