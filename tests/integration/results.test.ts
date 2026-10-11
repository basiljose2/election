import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import type { Actor } from "@/lib/auth/roles";
import { createBallotCommands } from "@/lib/commands/ballots";
import { CommandError } from "@/lib/commands/errors";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { defaultHooks, createLifecycleCommands } from "@/lib/lifecycle/engine";
import { defaultGuards } from "@/lib/lifecycle/guards";
import { createAppLifecycle } from "@/lib/lifecycle/app";
import { reconciliationGuards } from "@/lib/reconciliation/command";
import { resultCsv, resultJson, resultPdf } from "@/lib/results/exports";
import { getPollingDashboard } from "@/lib/results/polling-dashboard";
import { sha256Hex } from "@/lib/audit/chain";
import { loadResult, resultsGuards, resultsHooks, verifyResult } from "@/lib/results/declare";
import { MemorySignalBus } from "@/lib/signals/memory";
import { castBallot, fetchPendingBallot, type CastingDeps } from "@/lib/votes/casting";
import { ballotGuards, ballotHooks } from "@/lib/votes/guards";
import { parseMasterKey } from "@/lib/votes/keys";
import { tallyHooks, verifyTally } from "@/lib/votes/tally";
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

type Answers = ReturnType<typeof validAnswers>;

async function cast(w: VotingWorld, answers: Answers) {
  await executeCommand(
    ballots.issueBallotSession,
    { boothId: w.boothId, masterToken: w.masterToken },
    gw(w.po),
  );
  const pending = await fetchPendingBallot({ db: app }, w.voting);
  if (pending.status !== "pending") throw new Error("no pending ballot");
  const result = await castBallot(castingDeps, w.voting, {
    castToken: pending.castToken,
    idempotencyKey: randomUUID().replace(/-/g, ""),
    answers,
  });
  expect(result.status).toBe("cast");
}

/** Closes every booth and completes the polls: the Election is Polling Completed. */
async function completePolls(w: VotingWorld) {
  await executeCommand(
    lifecycle.closePoll,
    { electionId: w.electionId, boothId: w.boothId },
    gw(w.po),
  );
  if (w.other) {
    await setBoothState(admin, w.other.boothId, "open");
    await executeCommand(
      lifecycle.closePoll,
      { electionId: w.electionId, boothId: w.other.boothId },
      gw(w.other.po),
    );
  }
  await executeCommand(lifecycle.completePolls, { electionId: w.electionId }, gw(w.ro));
}

const declare = (w: VotingWorld, actor: Actor = w.ro) =>
  executeCommand(lifecycle.declareResults, { electionId: w.electionId }, gw(actor));

const status = async (w: VotingWorld) =>
  (
    await admin.query<{ status: string }>(
      "select status::text status from public.elections where id = $1",
      [w.electionId],
    )
  ).rows[0]!.status;

const resultRows = async (w: VotingWorld) =>
  Number(
    (
      await admin.query("select count(*) n from public.results where election_id = $1", [
        w.electionId,
      ])
    ).rows[0].n,
  );

const byName = (
  doc: NonNullable<Awaited<ReturnType<typeof loadResult>>>["document"],
  name: string,
) => doc.posts.find((p) => p.name === name)!;

describe("the polling dashboard", () => {
  it("shows booths and totals only: no per-candidate field exists (response schema)", async () => {
    const w = await buildVotingWorld(admin, { unmappedPost: true });
    await cast(w, validAnswers(w, { president: 1 }));
    const dashboard = await getPollingDashboard(app, w.ro, w.electionId);

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
    walk(dashboard);
    expect([...keys].sort()).toEqual(
      [
        "ballotPending",
        "ballotsCancelled",
        "ballotsCast",
        "boothId",
        "booths",
        "boothsClosed",
        "electionId",
        "electionName",
        "electionStatus",
        "generatedAt",
        "lastActivityAt",
        "masterOnline",
        "name",
        "state",
        "totals",
        "votingOnline",
      ].sort(),
    );
    const booth = dashboard.booths.find((b) => b.boothId === w.boothId)!;
    expect(booth).toMatchObject({ ballotsCast: 1, votingOnline: true, state: "open" });
    expect(booth.lastActivityAt).not.toBeNull();
    const text = JSON.stringify(dashboard);
    for (const id of [...w.presidents, ...w.councillors]) expect(text).not.toContain(id);

    // Observers may look; a Presiding Officer of the booth may not.
    await expect(getPollingDashboard(app, w.po, w.electionId)).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("declaring results", () => {
  it("computes, signs and stores the Result and moves the Election, audited with the hash", async () => {
    const w = await buildVotingWorld(admin, { unmappedPost: true });
    // President: 3 / 1 / 1 and one NOTA; Council: candidates 0 and 1 every time.
    for (const pick of [0, 0, 0, 1, 2]) {
      await cast(w, validAnswers(w, { president: pick, council: [0, 1] }));
    }
    await cast(w, validAnswers(w, { president: "nota", council: [0, 1] }));
    await completePolls(w);
    expect(await status(w)).toBe("polling_completed");

    await declare(w);
    expect(await status(w)).toBe("results_declared");

    const result = await loadResult(app, w.electionId);
    expect(result).not.toBeNull();
    expect(verifyResult(w.publicKey, result!)).toBe(true);

    const doc = result!.document;
    expect(doc.totals).toEqual({ ballots_cast: 6, ballots_cancelled: 0, booths: 2 });
    const president = byName(doc, "President");
    expect(president.status).toBe("elected");
    expect(president.candidates[0]).toMatchObject({
      id: w.presidents[0],
      votes: 3,
      outcome: "elected",
    });
    expect(president.nota).toBe(1);
    expect(president.answers).toBe(6);
    expect(president.margin).toBe(2);
    const council = byName(doc, "Council");
    expect(council.candidates.filter((c) => c.outcome === "elected").map((c) => c.votes)).toEqual([
      6, 6,
    ]);
    // The other booth's Post has no votes at all: a tie, never broken.
    expect(byName(doc, "Unmapped").status).toBe("tie");

    // Booth-wise rows add up to the Post totals.
    const totals = await admin.query(
      `select post_id, sum(votes)::int v, (booth_id is null) total
         from public.result_items where result_id = $1 group by post_id, (booth_id is null)`,
      [result!.id],
    );
    for (const post of [w.presidentId, w.councilId]) {
      const rows = totals.rows.filter((r) => r.post_id === post);
      expect(rows).toHaveLength(2);
      expect(rows[0].v).toBe(rows[1].v);
    }

    const events = await auditEvents(admin, {
      electionId: w.electionId,
      eventType: "election.results_declared",
    });
    expect(JSON.stringify(events[0]!.payload)).toContain(result!.resultHash);
  });

  it("exports carry the Result hash: signed JSON verifies, CSV rows and every PDF page have it", async () => {
    const w = await buildVotingWorld(admin, { unmappedPost: true });
    for (const pick of [0, 0, 1]) await cast(w, validAnswers(w, { president: pick }));
    await completePolls(w);
    await declare(w);
    const result = (await loadResult(app, w.electionId))!;

    const json = JSON.parse(resultJson(result, w.publicKey)) as {
      canonical_json: string;
      signature: string;
      result_hash: string;
      public_key: string;
    };
    expect(sha256Hex(json.canonical_json)).toBe(json.result_hash);
    expect(verifyTally(json.public_key, json.canonical_json, json.signature)).toBe(true);
    expect(verifyTally(json.public_key, json.canonical_json + " ", json.signature)).toBe(false);

    const csv = resultCsv(result);
    const dataRows = csv.trim().split(/\r?\n/).slice(1);
    expect(dataRows.length).toBeGreaterThan(5);
    expect(dataRows.every((r) => r.startsWith(result.resultHash))).toBe(true);
    expect(csv).toContain("President");

    const pdf = resultPdf(result).toString("latin1");
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    const pages = (pdf.match(/\/Type \/Page /g) ?? []).length;
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(pdf.split(`Result hash: ${result.resultHash}`).length - 1).toBe(pages);
    expect(pdf).toContain("President");
  });

  it("withholds a Post that failed reconciliation, declares the rest and shows unopposed Posts", async () => {
    const w = await buildVotingWorld(admin, {
      unmappedPost: true,
      unmappedCandidates: 1,
      councilAtOther: true,
    });
    await cast(w, [{ postId: w.presidentId, candidateIds: [w.presidents[0]!] }]);
    await completePolls(w);
    // A row appears in booth A's store after it closed.
    await admin.query(
      `insert into public.vote_selections (election_id, booth_id, post_id, candidate_id, signature)
       values ($1, $2, $3, $4, $5)`,
      [w.electionId, w.boothId, w.presidentId, w.presidents[1], "B".repeat(86)],
    );
    await declare(w);

    const result = (await loadResult(app, w.electionId))!;
    const doc = result.document;
    const president = byName(doc, "President");
    expect(president.status).toBe("withheld");
    expect(president.candidates.every((c) => c.votes === null)).toBe(true);
    expect(president.nota).toBeNull();
    expect(byName(doc, "Unmapped").status).toBe("unopposed");
    expect(byName(doc, "Council").status).toBe("tie"); // declared (0 votes each), not withheld

    // No count of the withheld Post anywhere in the stored Result.
    expect(doc.booth_wise.some((b) => b.post_id === w.presidentId)).toBe(false);
    const items = await admin.query(
      "select 1 from public.result_items where result_id = $1 and post_id = $2",
      [result.id, w.presidentId],
    );
    expect(items.rows).toHaveLength(0);
  });

  it("can be done once only", async () => {
    const w = await buildVotingWorld(admin, { unmappedPost: true });
    await completePolls(w);
    await declare(w);
    await expect(declare(w)).rejects.toSatisfy(
      (e) => e instanceof CommandError && e.code === "invalid_transition",
    );
    expect(await resultRows(w)).toBe(1);
  });

  it("needs recent re-authentication", async () => {
    const w = await buildVotingWorld(admin, { unmappedPost: true });
    await completePolls(w);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    await expect(
      declare(w, { ...w.ro, authTimes: { password: stale, totp: stale } }),
    ).rejects.toSatisfy((e) => e instanceof CommandError && e.code === "reauth_required");
    expect(await status(w)).toBe("polling_completed");
  });

  it("only the election's Returning Officer may declare", async () => {
    const w = await buildVotingWorld(admin, { unmappedPost: true });
    await completePolls(w);
    await expect(declare(w, w.po)).rejects.toSatisfy(
      (e) => e instanceof CommandError && e.code === "forbidden",
    );
  });

  it("a fault after the Result is stored leaves Polling Completed and no Result", async () => {
    const w = await buildVotingWorld(admin, { unmappedPost: true });
    await cast(w, validAnswers(w));
    await completePolls(w);
    const runsBefore = Number(
      (
        await admin.query(
          "select count(*) n from public.reconciliation_runs where election_id = $1",
          [w.electionId],
        )
      ).rows[0].n,
    );

    const faulty = createLifecycleCommands({
      publisher: bus,
      guards: { ...defaultGuards, ...ballotGuards, ...reconciliationGuards, ...resultsGuards },
      hooks: [
        ...defaultHooks,
        ...ballotHooks,
        ...tallyHooks(() => masterKey),
        ...resultsHooks(() => masterKey),
        {
          action: "declare_results",
          async run() {
            throw new Error("injected fault after the Result was written");
          },
        },
      ],
    });
    await expect(
      executeCommand(faulty.declareResults, { electionId: w.electionId }, gw(w.ro)),
    ).rejects.toThrow(/injected fault/);

    expect(await status(w)).toBe("polling_completed");
    expect(await resultRows(w)).toBe(0);
    const items = await admin.query(
      "select count(*) n from public.result_items i join public.results r on r.id = i.result_id where r.election_id = $1",
      [w.electionId],
    );
    expect(Number(items.rows[0].n)).toBe(0);
    const runsAfter = Number(
      (
        await admin.query(
          "select count(*) n from public.reconciliation_runs where election_id = $1",
          [w.electionId],
        )
      ).rows[0].n,
    );
    expect(runsAfter).toBe(runsBefore);

    // And the declaration still works afterwards.
    await declare(w);
    expect(await status(w)).toBe("results_declared");
  });

  it("a stored Result cannot be changed or removed by any role (negative test)", async () => {
    const w = await buildVotingWorld(admin, { unmappedPost: true });
    await completePolls(w);
    await declare(w);

    await expect(
      app.query("update public.results set result_hash = $1 where election_id = $2", [
        "0".repeat(64),
        w.electionId,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      app.query(
        "delete from public.result_items where result_id in (select id from public.results)",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      admin.query("update public.results set declared_by = null where election_id = $1", [
        w.electionId,
      ]),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(admin.query("truncate public.result_items")).rejects.toMatchObject({
      code: "P0001",
    });
  });

  it("per-candidate counts stay sealed until polling is completed", async () => {
    const w = await buildVotingWorld(admin, { unmappedPost: true });
    await expect(
      app.query("select * from public.election_booth_tally($1)", [w.electionId]),
    ).rejects.toMatchObject({ code: "42501" });
    await completePolls(w);
    const sealed = await app.query("select * from public.election_booth_tally($1)", [w.electionId]);
    expect(sealed.rows).toEqual([]);
  });
});
