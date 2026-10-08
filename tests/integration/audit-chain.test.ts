import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildAuditExport } from "@/lib/audit/export";
import { electionGrant } from "@/lib/auth/roles";
import { defineCommand, executeCommand } from "@/lib/commands/gateway";
import { appendAuditEvent } from "@/lib/audit/append";
// The verifier is standalone JavaScript with no application imports.
import { verifyAuditExport } from "../../tools/verifier/verify-audit.mjs";
import { actorFor, adminPool, appPool, createStaffFixture } from "../support/fixtures";

const app = appPool(10);
const admin = adminPool();

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const touchElection = defineCommand({
  name: "test.election_touched",
  input: z.object({ electionId: z.uuid(), n: z.number().int() }),
  authorize: (actor, input) => electionGrant(actor, input.electionId, ["returning_officer"]),
  describeTarget: (input) => ({
    electionId: input.electionId,
    target: { type: "election", id: input.electionId },
  }),
  async execute(_ctx, input) {
    return {
      result: input.n,
      audit: {
        electionId: input.electionId,
        target: { type: "election", id: input.electionId },
        before: null,
        after: { n: input.n },
      },
    };
  },
});

describe("audit hash chain under concurrency", () => {
  const electionId = randomUUID();
  let actor: ReturnType<typeof actorFor>;

  beforeAll(async () => {
    const ro = await createStaffFixture(admin, [{ role: "returning_officer", electionId }]);
    actor = actorFor(ro);
  });

  it("50 parallel commands produce a gapless, valid chain", async () => {
    const deps = {
      db: app,
      now: () => new Date(),
      authenticate: async () => actor,
      appendAudit: appendAuditEvent,
    };
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, n) => executeCommand(touchElection, { electionId, n }, deps)),
    );
    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, n) => n));

    const doc = await buildAuditExport(app, electionId);
    expect(doc.events.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(doc.events.map((e) => (e.payload.after as { n: number }).n)).size).toBe(50);
    expect(verifyAuditExport(doc)).toEqual({ ok: true, count: 50, head: doc.head_hash });
  });

  it("keeps separate elections on independent chains", async () => {
    const other = randomUUID();
    const ro = await createStaffFixture(admin, [{ role: "returning_officer", electionId: other }]);
    const deps = {
      db: app,
      now: () => new Date(),
      authenticate: async () => actorFor(ro),
      appendAudit: appendAuditEvent,
    };
    await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        executeCommand(touchElection, { electionId: other, n }, deps),
      ),
    );
    const doc = await buildAuditExport(app, other);
    expect(doc.event_count).toBe(10);
    expect(verifyAuditExport(doc).ok).toBe(true);
    expect(verifyAuditExport(await buildAuditExport(app, electionId)).ok).toBe(true);
  });

  it("the system chain verifies", async () => {
    expect(verifyAuditExport(await buildAuditExport(app, null)).ok).toBe(true);
  });
});
