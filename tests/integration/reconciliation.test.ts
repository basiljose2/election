import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import { canonicalJson } from "@/lib/audit/canonical-json";
import { sha256Hex } from "@/lib/audit/chain";
import type { Actor } from "@/lib/auth/roles";
import { createBallotCommands } from "@/lib/commands/ballots";
import { CommandError } from "@/lib/commands/errors";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { createAppLifecycle } from "@/lib/lifecycle/app";
import { reconcileElection } from "@/lib/reconciliation/command";
import {
  latestReconciliation,
  reconciliationPassed,
  type BoothReport,
  type ReconciliationReport,
} from "@/lib/reconciliation/run";
import { MemorySignalBus } from "@/lib/signals/memory";
import { castBallot, fetchPendingBallot, type CastingDeps } from "@/lib/votes/casting";
import { parseMasterKey } from "@/lib/votes/keys";
import { listFailedTallies } from "@/lib/votes/tally";
import { adminPool, appPool, auditEvents, setBoothState } from "../support/fixtures";
import { buildVotingWorld, validAnswers, type VotingWorld } from "../support/voting-world";

const app = appPool();
const admin = adminPool();
const bus = new MemorySignalBus();
const ballots = createBallotCommands(bus);
const lifecycle = createAppLifecycle(bus);
const masterKey = parseMasterKey(process.env.VOTE_SIGNING_MASTER_KEY);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const now = () => new Date();
const gw = (actor: Actor): Partial<GatewayDeps> => ({
  db: app,
  now,
  authenticate: async () => actor,
  appendAudit: appendAuditEvent,
});
const castingDeps: CastingDeps = {
  db: app,
  now,
  appendAudit: appendAuditEvent,
  publisher: bus,
  masterKey,
};

async function castOne(w: VotingWorld) {
  await executeCommand(
    ballots.issueBallotSession,
    { boothId: w.boothId, masterToken: w.masterToken },
    gw(w.po),
  );
  const pending = await fetchPendingBallot({ db: app }, w.voting);
  if (pending.status !== "pending") throw new Error("no pending ballot");
  await castBallot(castingDeps, w.voting, {
    castToken: pending.castToken,
    idempotencyKey: randomUUID().replace(/-/g, ""),
    answers: validAnswers(w),
  });
}

/** Two booths: A (President, Council) and B (the Post A is not mapped to), both closed. */
async function closedElection(ballotsAtA = 3) {
  const w = await buildVotingWorld(admin, { unmappedPost: true });
  for (let i = 0; i < ballotsAtA; i++) await castOne(w);
  await executeCommand(
    lifecycle.closePoll,
    { electionId: w.electionId, boothId: w.boothId },
    gw(w.po),
  );
  await setBoothState(admin, w.other!.boothId, "open");
  await executeCommand(
    lifecycle.closePoll,
    { electionId: w.electionId, boothId: w.other!.boothId },
    gw(w.other!.po),
  );
  return w;
}

const reconcile = async (w: VotingWorld): Promise<ReconciliationReport> =>
  (await executeCommand(reconcileElection, { electionId: w.electionId }, gw(w.ro))).report;

const booth = (report: ReconciliationReport, boothId: string): BoothReport =>
  report.booths.find((b) => b.boothId === boothId)!;
const failedChecks = (b: BoothReport) => b.checks.filter((c) => !c.passed).map((c) => c.check);
const electionFailed = (r: ReconciliationReport) =>
  r.electionChecks.filter((c) => !c.passed).map((c) => c.check);
const status = (r: ReconciliationReport, postId: string) =>
  r.posts.find((p) => p.postId === postId)?.status;

/** Runs `change` with the append-only triggers of a table switched off (owner only, tests only). */
async function tamper(table: string, change: () => Promise<unknown>) {
  const client = await admin.connect();
  try {
    await client.query(`alter table public.${table} disable trigger user`);
    try {
      await change();
    } finally {
      await client.query(`alter table public.${table} enable trigger user`);
    }
  } finally {
    client.release();
  }
}

describe("election reconciliation", () => {
  it("passes on an untouched election: every booth and Post is PASS, and it is audited", async () => {
    const w = await closedElection();
    const report = await reconcile(w);

    expect(report.electionChecksPassed).toBe(true);
    expect(electionFailed(report)).toEqual([]);
    for (const b of report.booths) {
      expect(failedChecks(b)).toEqual([]);
      expect(b.passed).toBe(true);
      expect(b.tallyHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(booth(report, w.boothId)).toMatchObject({ ballotsCast: 3, ballotsCancelled: 0 });
    expect(booth(report, w.boothId).answers.map((a) => a.answers)).toEqual([3, 3]);
    expect(report.posts.map((p) => p.status)).toEqual(["pass", "pass", "pass"]);
    expect(await reconciliationPassed(app, w.electionId, w.presidentId)).toBe(true);

    // No per-candidate data anywhere in the stored report.
    const json = JSON.stringify(await latestReconciliation(app, w.electionId));
    for (const id of [...w.presidents, ...w.councillors]) expect(json).not.toContain(id);
    expect(json).not.toMatch(/candidate_id|nota|votes/i);

    // Each check's outcome is in the Audit Event.
    const events = await auditEvents(admin, {
      electionId: w.electionId,
      eventType: "election.reconciled",
    });
    expect(events).toHaveLength(1);
    const detail = events[0]!.payload.detail as {
      election_checks: Array<{ check: string; passed: boolean }>;
      booths: Array<{ checks: unknown[] }>;
    };
    expect(detail.election_checks.map((c) => c.check)).toEqual([
      "audit_chain",
      "setup_unchanged",
      "ballot_definitions_unchanged",
      "no_pending_sessions",
    ]);
    expect(detail.booths).toHaveLength(2);
  });

  it("reports post-close tampering: a Vote Selection added after the booth closed", async () => {
    const w = await closedElection();
    await admin.query(
      `insert into public.vote_selections (election_id, booth_id, post_id, candidate_id, signature)
       values ($1, $2, $3, $4, $5)`,
      [w.electionId, w.boothId, w.presidentId, w.presidents[0], "B".repeat(86)],
    );
    const report = await reconcile(w);

    const failed = failedChecks(booth(report, w.boothId));
    expect(failed).toContain("count_and_root_match");
    expect(failed).toContain("selection_signatures");
    expect(failed).toContain("answer_rule");
    expect(booth(report, w.other!.boothId).passed).toBe(true);
  });

  it("one booth failing fails only the Posts mapped to it", async () => {
    const w = await closedElection();
    await admin.query(
      `insert into public.vote_selections (election_id, booth_id, post_id, candidate_id, signature)
       values ($1, $2, $3, $4, $5)`,
      [w.electionId, w.boothId, w.presidentId, w.presidents[0], "B".repeat(86)],
    );
    const report = await reconcile(w);

    expect(status(report, w.presidentId)).toBe("failed");
    expect(status(report, w.councilId)).toBe("failed");
    expect(status(report, w.unmapped!.postId)).toBe("pass");
    expect(await reconciliationPassed(app, w.electionId, w.presidentId)).toBe(false);
    expect(await reconciliationPassed(app, w.electionId, w.unmapped!.postId)).toBe(true);
    // Booth A failing is not an election-wide failure.
    expect(report.electionChecksPassed).toBe(true);
  });

  it("detects a tampered Booth Tally signature", async () => {
    const w = await closedElection();
    await tamper("booth_tallies", () =>
      admin.query("update public.booth_tallies set signature = $2 where booth_id = $1", [
        w.boothId,
        "C".repeat(86),
      ]),
    );
    const report = await reconcile(w);
    expect(failedChecks(booth(report, w.boothId))).toEqual(["tally_signature"]);
  });

  it("detects an altered Audit Event", async () => {
    const w = await closedElection();
    await tamper("audit_events", () =>
      admin.query(
        `update public.audit_events
            set payload = jsonb_set(payload, '{detail}', '{"tampered": true}')
          where chain_key = $1::uuid
            and seq = (select max(seq) from public.audit_events where chain_key = $1::uuid)`,
        [w.electionId],
      ),
    );
    const report = await reconcile(w);
    expect(electionFailed(report)).toEqual(["audit_chain"]);
    expect(report.electionChecksPassed).toBe(false);
    expect(report.posts.every((p) => p.status === "failed")).toBe(true);
  });

  it("detects an altered Ballot Definition even when its own hash is made to match", async () => {
    const w = await closedElection();
    const { rows } = await admin.query<{ canonical_json: string }>(
      "select canonical_json from public.ballot_definitions where booth_id = $1",
      [w.boothId],
    );
    const altered = canonicalJson({ ...JSON.parse(rows[0]!.canonical_json), nota_enabled: false });
    await tamper("ballot_definitions", () =>
      admin.query(
        "update public.ballot_definitions set canonical_json = $2, definition_hash = $3 where booth_id = $1",
        [w.boothId, altered, sha256Hex(altered)],
      ),
    );
    const report = await reconcile(w);
    expect(electionFailed(report)).toEqual(["ballot_definitions_unchanged"]);
  });

  it("detects an altered setup snapshot even when its hash is made to match", async () => {
    const w = await closedElection();
    const { rows } = await admin.query<{ canonical_json: string }>(
      "select canonical_json from public.setup_snapshots where election_id = $1",
      [w.electionId],
    );
    const altered = canonicalJson({ ...JSON.parse(rows[0]!.canonical_json), nota_enabled: false });
    await tamper("setup_snapshots", () =>
      admin.query(
        "update public.setup_snapshots set canonical_json = $2, setup_hash = $3 where election_id = $1",
        [w.electionId, altered, sha256Hex(altered)],
      ),
    );
    const report = await reconcile(w);
    expect(electionFailed(report)).toContain("setup_unchanged");
  });

  it("reports a pending Ballot Session", async () => {
    const w = await closedElection();
    await admin.query(
      `insert into public.ballot_sessions (election_id, booth_id, terminal_id, is_mock, issued_by)
       values ($1, $2, $3, false, $4)`,
      [w.electionId, w.boothId, w.voting.id, w.po.userId],
    );
    const report = await reconcile(w);
    expect(electionFailed(report)).toEqual(["no_pending_sessions"]);
  });

  it("the stored report has a fixed, count-free shape (response schema)", async () => {
    const w = await closedElection();
    await reconcile(w);
    const report = await latestReconciliation(app, w.electionId);

    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
      }
    };
    walk(report);
    const allowed = new Set([
      "version",
      "electionId",
      "ranAt",
      "electionChecks",
      "electionChecksPassed",
      "booths",
      "posts",
      "check",
      "passed",
      "detail",
      "boothId",
      "boothName",
      "state",
      "ballotsCast",
      "ballotsCancelled",
      "tallyHash",
      "answers",
      "postId",
      "postName",
      "checks",
      "status",
      "reasons",
    ]);
    expect([...keys].filter((k) => !allowed.has(k))).toEqual([]);
  });

  it("failed Booth Tallies are listed for the Returning Officer's dashboard alert", async () => {
    const w = await buildVotingWorld(admin);
    await castOne(w);
    await admin.query(
      "update public.booth_counters set ballots_cast = ballots_cast + 1 where booth_id = $1",
      [w.boothId],
    );
    await executeCommand(
      lifecycle.closePoll,
      { electionId: w.electionId, boothId: w.boothId },
      gw(w.po),
    );
    const alerts = await listFailedTallies(app, w.electionId);
    expect(alerts).toEqual([
      expect.objectContaining({
        boothId: w.boothId,
        boothName: "Main Hall",
        failedChecks: ["answers_match_ballots"],
      }),
    ]);
  });

  it("is refused for anyone but the election's Returning Officer", async () => {
    const w = await closedElection();
    const other = await buildVotingWorld(admin);
    await expect(
      executeCommand(reconcileElection, { electionId: w.electionId }, gw(w.po)),
    ).rejects.toSatisfy((e) => e instanceof CommandError && e.code === "forbidden");
    await expect(
      executeCommand(reconcileElection, { electionId: w.electionId }, gw(other.ro)),
    ).rejects.toSatisfy((e) => e instanceof CommandError && e.code === "forbidden");
  });

  it("an unreconciled Post never passes", async () => {
    const w = await closedElection();
    expect(await reconciliationPassed(app, w.electionId, w.presidentId)).toBe(false);
  });
});

describe("the declaration guard", () => {
  async function declare(w: VotingWorld) {
    await admin.query("update public.elections set status = 'polling_completed' where id = $1", [
      w.electionId,
    ]);
    return executeCommand(lifecycle.declareResults, { electionId: w.electionId }, gw(w.ro)).then(
      () => null,
      (e: unknown) => (e instanceof CommandError ? e.message : String(e)),
    );
  }

  it("blocks declaration when an election-wide check fails", async () => {
    const w = await closedElection();
    await tamper("audit_events", () =>
      admin.query(
        `update public.audit_events set payload = jsonb_set(payload, '{detail}', '{"x": 1}')
          where chain_key = $1::uuid
            and seq = (select max(seq) from public.audit_events where chain_key = $1::uuid)`,
        [w.electionId],
      ),
    );
    expect(await declare(w)).toMatch(/the election reconciliation failed: audit chain/);
  });

  it("does not itself block a clean election (only results-dashboard's check remains)", async () => {
    const w = await closedElection();
    const message = await declare(w);
    expect(message).not.toMatch(/reconciliation failed/);
    expect(message).toMatch(/resultsReady/);
  });
});
