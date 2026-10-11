import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import type { Actor } from "@/lib/auth/roles";
import { createBallotCommands } from "@/lib/commands/ballots";
import { CommandError } from "@/lib/commands/errors";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { MemorySignalBus } from "@/lib/signals/memory";
import { castBallot, fetchPendingBallot, type CastingDeps } from "@/lib/votes/casting";
import { parseMasterKey } from "@/lib/votes/keys";
import { adminPool, appPool, auditEvents } from "../support/fixtures";
import { buildVotingWorld, validAnswers, type VotingWorld } from "../support/voting-world";

const app = appPool();
const admin = adminPool();
const bus = new MemorySignalBus();
const ballots = createBallotCommands(bus);
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

const issue = (w: VotingWorld) =>
  executeCommand(
    ballots.issueBallotSession,
    { boothId: w.boothId, masterToken: w.masterToken },
    gw(w.po),
  );
const cancelAsOfficer = (w: VotingWorld, actor: Actor = w.ro, note = "Master Terminal failed") =>
  executeCommand(
    ballots.cancelPendingBallotAsOfficer,
    { electionId: w.electionId, boothId: w.boothId, note },
    gw(actor),
  );
const counters = async (boothId: string) =>
  (
    await admin.query(
      "select ballots_cast::int cast, ballots_cancelled::int cancelled from public.booth_counters where booth_id = $1",
      [boothId],
    )
  ).rows[0] as { cast: number; cancelled: number };
const code = (e: unknown) => (e instanceof CommandError ? e.code : String(e));

describe("the Returning Officer cancels a pending ballot", () => {
  it("cancels it without the Master Terminal: nothing stored, counted, kiosk locks, audited", async () => {
    const w = await buildVotingWorld(admin);
    await issue(w);
    const pending = await fetchPendingBallot({ db: app }, w.voting);
    if (pending.status !== "pending") throw new Error("no pending ballot");
    bus.published.length = 0;

    await cancelAsOfficer(w);

    const { rows } = await admin.query(
      "select status, cancel_reason, cancel_note from public.ballot_sessions where booth_id = $1",
      [w.boothId],
    );
    expect(rows).toEqual([
      {
        status: "cancelled",
        cancel_reason: "terminal_fault",
        cancel_note: "Master Terminal failed",
      },
    ]);
    expect(await counters(w.boothId)).toEqual({ cast: 0, cancelled: 1 });
    expect(bus.published.map((p) => p.signal.type)).toEqual(["ballot-cancelled"]);

    // The voter's kiosk can no longer cast with the token it was given.
    const result = await castBallot(castingDeps, w.voting, {
      castToken: pending.castToken,
      idempotencyKey: randomUUID().replace(/-/g, ""),
      answers: validAnswers(w),
    });
    expect(result).toEqual({ status: "rejected", reason: "cancelled" });
    const votes = await admin.query(
      "select count(*) n from public.vote_selections where booth_id = $1",
      [w.boothId],
    );
    expect(Number(votes.rows[0].n)).toBe(0);

    const events = await auditEvents(admin, {
      electionId: w.electionId,
      eventType: "ballot.session_cancelled_by_officer",
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      actor: { user_id: w.ro.userId, role: "returning_officer" },
      detail: { by: "returning_officer", note: "Master Terminal failed", is_mock: false },
    });

    // And the booth can issue the next ballot straight away.
    await expect(issue(w)).resolves.toMatchObject({ isMock: false });
  });

  it("a cancelled mock ballot is not counted", async () => {
    const w = await buildVotingWorld(admin, { booth: "mock_poll" });
    await issue(w);
    await cancelAsOfficer(w);
    expect(await counters(w.boothId)).toEqual({ cast: 0, cancelled: 0 });
  });

  it("is refused for a Presiding Officer, another election's officer and without a reason", async () => {
    const w = await buildVotingWorld(admin);
    const other = await buildVotingWorld(admin);
    await issue(w);

    await expect(cancelAsOfficer(w, w.po)).rejects.toSatisfy((e) => code(e) === "forbidden");
    await expect(cancelAsOfficer(w, other.ro)).rejects.toSatisfy((e) => code(e) === "forbidden");
    await expect(cancelAsOfficer(w, w.ro, "x")).rejects.toSatisfy(
      (e) => code(e) === "invalid_input",
    );
    // A booth of another election is "not found" under this election's grant.
    await expect(
      executeCommand(
        ballots.cancelPendingBallotAsOfficer,
        { electionId: other.electionId, boothId: w.boothId, note: "wrong election" },
        gw(other.ro),
      ),
    ).rejects.toSatisfy((e) => code(e) === "not_found");

    const { rows } = await admin.query(
      "select status from public.ballot_sessions where booth_id = $1",
      [w.boothId],
    );
    expect(rows).toEqual([{ status: "pending" }]);
  });

  it("needs recent re-authentication", async () => {
    const w = await buildVotingWorld(admin);
    await issue(w);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    await expect(
      cancelAsOfficer(w, { ...w.ro, authTimes: { password: stale, totp: stale } }),
    ).rejects.toSatisfy((e) => code(e) === "reauth_required");
  });

  it("says so when there is nothing to cancel", async () => {
    const w = await buildVotingWorld(admin);
    await expect(cancelAsOfficer(w)).rejects.toSatisfy(
      (e) => code(e) === "lifecycle" && /no pending ballot/.test((e as Error).message),
    );
  });
});
