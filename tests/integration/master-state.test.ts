import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import type { Actor } from "@/lib/auth/roles";
import { createBallotCommands } from "@/lib/commands/ballots";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { MemorySignalBus } from "@/lib/signals/memory";
import {
  getTerminalState,
  OFFLINE_AFTER_MS,
  type MasterTerminalState,
} from "@/lib/terminals/state";
import { castBallot, fetchPendingBallot, type CastingDeps } from "@/lib/votes/casting";
import { parseMasterKey } from "@/lib/votes/keys";
import { adminPool, appPool } from "../support/fixtures";
import { buildVotingWorld, validAnswers, type VotingWorld } from "../support/voting-world";

const app = appPool();
const admin = adminPool();
const bus = new MemorySignalBus();
const ballots = createBallotCommands(bus);
const masterKey = parseMasterKey(process.env.VOTE_SIGNING_MASTER_KEY);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

let clock = new Date();
const now = () => clock;
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

const masterState = async (w: VotingWorld) =>
  (await getTerminalState(
    { db: app, now, appendAudit: appendAuditEvent },
    w.masterTerminal,
  )) as MasterTerminalState;

const allowedNames = (state: MasterTerminalState) =>
  state.allowedActions.filter((a) => a.allowed).map((a) => a.action);

describe("Master Terminal state", () => {
  it("names the election and booth and offers the actions for an open booth", async () => {
    clock = new Date();
    const w = await buildVotingWorld(admin, { now: clock });
    const state = await masterState(w);

    expect(state).toMatchObject({
      role: "master",
      boothName: "Main Hall",
      boothState: "open",
      ballotPending: false,
      ballotsCast: 0,
      ballotsCancelled: 0,
      mock: { round: 0, ballotsCast: 0, ballotsCancelled: 0 },
    });
    expect(state.electionName).toMatch(/^Casting /);
    expect(allowedNames(state)).toEqual(["issue_ballot", "close_poll"]);
  });

  it("blocks the Ballot button when the Voting Terminal goes offline, and says why", async () => {
    clock = new Date();
    const w = await buildVotingWorld(admin, { now: clock });
    clock = new Date(clock.getTime() + OFFLINE_AFTER_MS + 1000);

    const state = await masterState(w);
    expect(state.votingTerminal.online).toBe(false);
    expect(allowedNames(state)).toEqual(["close_poll"]);
    expect(state.allowedActions.find((a) => a.action === "issue_ballot")).toMatchObject({
      allowed: false,
      reason: "The Voting Terminal is offline",
    });
  });

  it("a pending ballot allows only cancel; close shows the pending reason", async () => {
    clock = new Date();
    const w = await buildVotingWorld(admin, { now: clock });
    await executeCommand(
      ballots.issueBallotSession,
      { boothId: w.boothId, masterToken: w.masterToken },
      gw(w.po),
    );
    const state = await masterState(w);
    expect(state.ballotPending).toBe(true);
    expect(allowedNames(state)).toEqual(["cancel_ballot"]);
    expect(state.allowedActions.find((a) => a.action === "close_poll")?.reason).toBe(
      "A ballot is pending: wait or cancel",
    );
  });

  it("during a mock poll the mock round is counted separately from the real counts", async () => {
    clock = new Date();
    const w = await buildVotingWorld(admin, { now: clock, booth: "mock_poll" });
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
    await executeCommand(
      ballots.issueBallotSession,
      { boothId: w.boothId, masterToken: w.masterToken },
      gw(w.po),
    );
    await executeCommand(
      ballots.cancelBallotSession,
      { boothId: w.boothId, masterToken: w.masterToken, reason: "voter_left" },
      gw(w.po),
    );

    const state = await masterState(w);
    expect(state).toMatchObject({
      boothState: "mock_poll",
      ballotsCast: 0,
      ballotsCancelled: 0,
      mock: { round: 1, ballotsCast: 1, ballotsCancelled: 1 },
    });
    expect(allowedNames(state)).toEqual(["issue_ballot", "clear_mock_poll"]);

    // Counts only: not a candidate id anywhere in what the Master Terminal receives.
    const everything = JSON.stringify(state);
    for (const id of [...w.presidents, ...w.councillors]) expect(everything).not.toContain(id);
  });
});
