/**
 * Freezes an Election through the real freeze command (Ballot Definitions, Setup Hash, signing
 * key). Used by the Playwright global setup, which cannot import server-only application code.
 *
 *   tsx --conditions=react-server scripts/e2e-freeze.ts <electionId> <returningOfficerUserId>
 *
 * Local test stack only: it connects with TEST_ADMIN_DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import { Pool } from "pg";
import { appendAuditEvent } from "@/lib/audit/append";
import { freezeSetup } from "@/lib/commands/freeze";
import { withTransaction } from "@/lib/db/pool";
import { assertLocal } from "../tests/support/local-only";

config({ path: ".env.test.local", quiet: true });
config({ path: ".env.local", quiet: true });

async function main() {
  const [electionId, userId] = process.argv.slice(2);
  if (!electionId || !userId) throw new Error("usage: e2e-freeze <electionId> <userId>");
  const db = new Pool({
    connectionString: assertLocal("TEST_ADMIN_DATABASE_URL", process.env.TEST_ADMIN_DATABASE_URL),
    max: 1,
  });
  try {
    // The gateway's steps for this one command, run directly: the gateway module itself pulls
    // in request-scoped Next.js code that cannot load outside the framework.
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
          userId,
          sessionId: randomUUID(),
          email: "e2e-freeze@example.test",
          displayName: "E2E freeze",
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
        electionId: outcome.audit.electionId,
        eventType: freezeSetup.name,
        actor: { user_id: userId, role: grant.role, terminal_id: null },
        target: outcome.audit.target,
        before: outcome.audit.before,
        after: outcome.audit.after,
        detail: outcome.audit.detail ?? null,
      });
    });
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
