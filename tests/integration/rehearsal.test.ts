import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import type { Actor } from "@/lib/auth/roles";
import { createBallotCommands } from "@/lib/commands/ballots";
import { freezeSetup } from "@/lib/commands/freeze";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { createAppLifecycle } from "@/lib/lifecycle/app";
import { runReconciliation } from "@/lib/reconciliation/run";
import { loadResult } from "@/lib/results/declare";
import { MemorySignalBus } from "@/lib/signals/memory";
import { hashCredential, type AuthenticatedTerminal } from "@/lib/terminals/credentials";
import { ensureBundle } from "@/lib/transparency/bundle";
import { castBallot, fetchPendingBallot, type CastingDeps } from "@/lib/votes/casting";
import { parseMasterKey } from "@/lib/votes/keys";
import { verifyBundle } from "../../tools/verifier/lib/bundle.mjs";
import { readZip } from "../../tools/verifier/lib/zip.mjs";
import {
  actorFor,
  adminPool,
  appPool,
  createStaffFixture,
  setBoothState,
} from "../support/fixtures";

/**
 * The dress rehearsal as an automated script: a full election from setup to declaration with
 * 3 booths, a multi-seat Post, a booth-specific Post and NOTA, driven through the real commands
 * and casting path, then checked against the counts the script itself predicts. The production
 * rehearsal (docs/runbooks/dress-rehearsal.md) follows the same script with real devices.
 */

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

interface Booth {
  id: string;
  name: string;
  po: Actor;
  masterToken: string;
  voting: AuthenticatedTerminal;
  postNames: string[];
}

describe("dress rehearsal election", () => {
  it("runs from setup to a verified declaration with the scripted counts", async () => {
    // ---- Setup: Posts, candidates, booths (booth 3 also has a booth-specific Post).
    const electionId = randomUUID();
    await admin.query(
      "insert into public.elections (id, name, polling_date, nota_enabled) values ($1, 'Rehearsal', current_date, true)",
      [electionId],
    );
    const post = async (name: string, order: number, seats: number, candidates: number) => {
      const id = randomUUID();
      await admin.query(
        "insert into public.posts (id, election_id, name, display_order, seats) values ($1, $2, $3, $4, $5)",
        [id, electionId, name, order, seats],
      );
      const ids: string[] = [];
      for (let i = 0; i < candidates; i++) {
        const candidate = randomUUID();
        ids.push(candidate);
        await admin.query(
          "insert into public.candidates (id, election_id, post_id, name, sort_order) values ($1, $2, $3, $4, $5)",
          [candidate, electionId, id, `${name} ${String.fromCharCode(65 + i)}`, i],
        );
      }
      return { id, name, seats, candidates: ids };
    };
    const president = await post("President", 0, 1, 3);
    const council = await post("Council", 1, 2, 4); // multi-seat
    const sports = await post("Sports Secretary", 2, 1, 2); // booth-specific

    const boothDefs: Array<{ name: string; posts: Array<typeof president> }> = [
      { name: "Booth 1", posts: [president, council] },
      { name: "Booth 2", posts: [president, council] },
      { name: "Booth 3", posts: [president, council, sports] },
    ];
    const booths: Booth[] = [];
    for (const def of boothDefs) {
      const id = randomUUID();
      await admin.query(
        "insert into public.booths (id, election_id, name, location) values ($1, $2, $3, 'Hall')",
        [id, electionId, def.name],
      );
      for (const p of def.posts) {
        await admin.query(
          "insert into public.booth_posts (election_id, booth_id, post_id) values ($1, $2, $3)",
          [electionId, id, p.id],
        );
      }
      const po = actorFor(
        await createStaffFixture(admin, [{ role: "presiding_officer", electionId, boothId: id }]),
      );
      booths.push({
        id,
        name: def.name,
        po,
        masterToken: "",
        voting: null as unknown as AuthenticatedTerminal,
        postNames: def.posts.map((p) => p.name),
      });
    }
    const ro = actorFor(
      await createStaffFixture(admin, [{ role: "returning_officer", electionId }]),
    );

    // ---- Freeze (the real freeze), then open polling and pair terminals.
    await executeCommand(freezeSetup, { electionId }, { ...gw(ro), db: admin });
    await admin.query("update public.elections set status = 'polling_open' where id = $1", [
      electionId,
    ]);
    for (const booth of booths) {
      booth.masterToken = randomBytes(32).toString("base64url");
      await admin.query(
        "insert into public.terminals (election_id, booth_id, type, credential_hash) values ($1, $2, 'master', $3)",
        [electionId, booth.id, hashCredential(booth.masterToken)],
      );
      const voting = await admin.query<{ id: string }>(
        `insert into public.terminals (election_id, booth_id, type, credential_hash, device_id)
         values ($1, $2, 'voting', $3, 'RH01') returning id`,
        [electionId, booth.id, hashCredential(randomBytes(32).toString("base64url"))],
      );
      await admin.query(
        "insert into public.terminal_heartbeats (terminal_id, last_seen_at) values ($1, now())",
        [voting.rows[0]!.id],
      );
      booth.voting = {
        id: voting.rows[0]!.id,
        electionId,
        boothId: booth.id,
        type: "voting",
        deviceId: "RH01",
      };
      // Mock poll first (one test ballot, cleared), then open: the real sequence.
      await setBoothState(admin, booth.id, "mock_poll");
      await admin.query("update public.booth_counters set mock_round = 1 where booth_id = $1", [
        booth.id,
      ]);
      await setBoothState(admin, booth.id, "open");
    }

    // ---- Polling: scripted ballots through issue -> fetch -> cast.
    // President picks and Council pairs per ballot (indexes into the candidate lists), or NOTA.
    type Pick = number | "nota";
    const script: Record<string, Array<{ p: Pick; c: [number, number] | "nota"; s?: Pick }>> = {
      "Booth 1": [
        { p: 0, c: [0, 1] },
        { p: 0, c: [0, 2] },
        { p: 1, c: [1, 2] },
        { p: "nota", c: [0, 1] },
      ],
      "Booth 2": [
        { p: 0, c: [0, 1] },
        { p: 2, c: [0, 3] },
        { p: 1, c: "nota" },
      ],
      "Booth 3": [
        { p: 0, c: [1, 2], s: 0 },
        { p: 1, c: [0, 1], s: 1 },
        { p: 0, c: [0, 1], s: "nota" },
        { p: 0, c: [2, 3], s: 0 },
      ],
    };
    const expected = {
      president: new Map<string, number>(),
      council: new Map<string, number>(),
      sports: new Map<string, number>(),
      nota: { president: 0, council: 0, sports: 0 },
      ballots: 0,
    };
    const bump = (map: Map<string, number>, id: string) => map.set(id, (map.get(id) ?? 0) + 1);

    for (const booth of booths) {
      for (const ballot of script[booth.name]!) {
        const answers: Array<{ postId: string; candidateIds?: string[]; nota?: boolean }> = [];
        if (ballot.p === "nota") {
          answers.push({ postId: president.id, nota: true });
          expected.nota.president += 1;
        } else {
          answers.push({ postId: president.id, candidateIds: [president.candidates[ballot.p]!] });
          bump(expected.president, president.candidates[ballot.p]!);
        }
        if (ballot.c === "nota") {
          answers.push({ postId: council.id, nota: true });
          expected.nota.council += 1;
        } else {
          const picked = ballot.c.map((i) => council.candidates[i]!);
          answers.push({ postId: council.id, candidateIds: picked });
          for (const id of picked) bump(expected.council, id);
        }
        if (booth.name === "Booth 3") {
          if (ballot.s === "nota") {
            answers.push({ postId: sports.id, nota: true });
            expected.nota.sports += 1;
          } else {
            answers.push({
              postId: sports.id,
              candidateIds: [sports.candidates[ballot.s as number]!],
            });
            bump(expected.sports, sports.candidates[ballot.s as number]!);
          }
        }

        await executeCommand(
          ballots.issueBallotSession,
          { boothId: booth.id, masterToken: booth.masterToken },
          gw(booth.po),
        );
        const pending = await fetchPendingBallot({ db: app }, booth.voting);
        if (pending.status !== "pending") throw new Error("no pending ballot");
        const result = await castBallot(castingDeps, booth.voting, {
          castToken: pending.castToken,
          idempotencyKey: randomUUID().replace(/-/g, ""),
          answers,
        });
        expect(result.status).toBe("cast");
        expected.ballots += 1;
      }
    }

    // One ballot is cancelled at booth 2 (voter left): counted as cancelled, not as a vote.
    await executeCommand(
      ballots.issueBallotSession,
      { boothId: booths[1]!.id, masterToken: booths[1]!.masterToken },
      gw(booths[1]!.po),
    );
    await executeCommand(
      ballots.cancelBallotSession,
      { boothId: booths[1]!.id, masterToken: booths[1]!.masterToken, reason: "voter_left" },
      gw(booths[1]!.po),
    );

    // ---- Close every booth, complete the polls, declare.
    for (const booth of booths) {
      await executeCommand(lifecycle.closePoll, { electionId, boothId: booth.id }, gw(booth.po));
    }
    await executeCommand(lifecycle.completePolls, { electionId }, gw(ro));
    await executeCommand(lifecycle.declareResults, { electionId }, gw(ro));

    // ---- The Result equals the script's expected counts.
    const result = (await loadResult(app, electionId))!;
    const doc = result.document;
    expect(doc.totals).toEqual({ ballots_cast: 11, ballots_cancelled: 1, booths: 3 });

    const votesOf = (name: string) => {
      const p = doc.posts.find((x) => x.name === name)!;
      return {
        post: p,
        byId: new Map(p.candidates.map((c) => [c.id, c.votes])),
      };
    };
    for (const [name, map, nota] of [
      ["President", expected.president, expected.nota.president],
      ["Council", expected.council, expected.nota.council],
      ["Sports Secretary", expected.sports, expected.nota.sports],
    ] as const) {
      const { post: p, byId } = votesOf(name);
      for (const [id, votes] of byId) expect(votes, `${name} ${id}`).toBe(map.get(id) ?? 0);
      expect(p.nota, `${name} NOTA`).toBe(nota);
    }
    // President: A has the most votes and is elected.
    const pres = votesOf("President").post;
    expect(pres.status).toBe("elected");
    expect(pres.candidates[0]).toMatchObject({ name: "President A", outcome: "elected" });
    // The numbers written in docs/runbooks/dress-rehearsal.md.
    expect(pres.candidates.map((c) => c.votes)).toEqual([6, 3, 1]);
    expect(pres.nota).toBe(1);
    expect(pres.margin).toBe(3);
    const councilPost = votesOf("Council").post;
    expect(councilPost.candidates.map((c) => [c.name, c.votes])).toEqual([
      ["Council A", 7],
      ["Council B", 7],
      ["Council C", 4],
      ["Council D", 2],
    ]);
    expect(councilPost.status).toBe("elected");
    expect(
      councilPost.candidates.filter((c) => c.outcome === "elected").map((c) => c.name),
    ).toEqual(["Council A", "Council B"]);
    expect(councilPost.nota).toBe(1);
    expect(councilPost.margin).toBe(3);
    expect(doc.posts.some((p) => p.notaExceededWinner || p.status === "tie")).toBe(false);
    const sportsPost = votesOf("Sports Secretary").post;
    expect(sportsPost.candidates.map((c) => c.votes)).toEqual([2, 1]);
    expect(sportsPost.nota).toBe(1);
    expect(doc.booth_wise.some((b) => b.booth_name === "Booth 3" && b.post_id === sports.id)).toBe(
      true,
    );
    expect(doc.booth_wise.some((b) => b.booth_name !== "Booth 3" && b.post_id === sports.id)).toBe(
      false,
    );

    // ---- Reconciliation passes, and the verifier passes on the bundle.
    const report = await runReconciliation(app, { electionId, now: new Date() });
    expect(report.electionChecksPassed).toBe(true);
    expect(report.booths.every((b) => b.passed)).toBe(true);
    expect(report.posts.every((p) => p.status === "pass")).toBe(true);

    const bundle = await ensureBundle(app, electionId);
    const verdict = await verifyBundle(await readZip(new Uint8Array(bundle!.zip)));
    expect(verdict.checks.filter((c: { status: string }) => c.status === "fail")).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.resultHash).toBe(result.resultHash);
    expect(verdict.checks.find((c: { id: string }) => c.id === "recount")?.status).toBe("pass");
  });
});
