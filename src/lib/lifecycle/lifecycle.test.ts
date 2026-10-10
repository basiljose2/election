import { describe, expect, it } from "vitest";
import { fail, pass, runGuards, type GuardContext, type GuardRegistry } from "./guards";
import {
  BOOTH_STATES,
  BOOTH_TRANSITIONS,
  ELECTION_STATES,
  ELECTION_TRANSITIONS,
  findTransition,
  pairsOf,
  type BoothAction,
  type ElectionAction,
} from "./tables";

const ELECTION_ACTIONS: ElectionAction[] = [
  "freeze",
  "unfreeze",
  "start_polling",
  "complete_polls",
  "declare_results",
  "archive",
];
const BOOTH_ACTIONS: BoothAction[] = [
  "start_mock_poll",
  "clear_mock_poll",
  "repeat_mock_poll",
  "open_poll",
  "close_poll",
  "force_close_poll",
  "seal",
];

/** The permitted transitions, written out independently of the table under test. */
const EXPECTED_ELECTION = new Set([
  "draft/freeze>frozen",
  "frozen/unfreeze>draft",
  "frozen/start_polling>polling_open",
  "polling_open/complete_polls>polling_completed",
  "polling_completed/declare_results>results_declared",
  "results_declared/archive>archived",
]);
const EXPECTED_BOOTH = new Set([
  "setup/start_mock_poll>mock_poll",
  "mock_poll/clear_mock_poll>mock_cleared",
  "mock_cleared/repeat_mock_poll>mock_poll",
  "mock_cleared/open_poll>open",
  "open/close_poll>closed",
  "open/force_close_poll>closed",
  "closed/seal>sealed",
]);

describe("Election transition table", () => {
  it("allows exactly the listed (state, action) pairs and nothing else", () => {
    const allowed = new Set<string>();
    for (const state of ELECTION_STATES) {
      for (const action of ELECTION_ACTIONS) {
        const row = findTransition(ELECTION_TRANSITIONS, state, action);
        if (row) allowed.add(`${state}/${action}>${row.to}`);
      }
    }
    expect(allowed).toEqual(EXPECTED_ELECTION);
    expect(ELECTION_STATES.length * ELECTION_ACTIONS.length).toBe(36); // every pair was checked
  });

  it("never skips a state or goes backwards (except unfreeze)", () => {
    const order = ELECTION_STATES as readonly string[];
    for (const row of ELECTION_TRANSITIONS) {
      const step = order.indexOf(row.to) - order.indexOf(row.from);
      expect(row.action === "unfreeze" ? step === -1 : step === 1).toBe(true);
    }
  });

  it("restricts who may run each transition", () => {
    const roles = (action: ElectionAction) =>
      ELECTION_TRANSITIONS.find((r) => r.action === action)!.allowedRoles;
    expect(roles("start_polling")).toEqual(["returning_officer"]);
    expect(roles("complete_polls")).toEqual(["returning_officer"]);
    expect(roles("declare_results")).toEqual(["returning_officer"]);
    expect(roles("archive")).toEqual(["super_admin"]);
  });

  it("requires re-authentication for the critical transitions", () => {
    const reauth = (action: ElectionAction) =>
      ELECTION_TRANSITIONS.find((r) => r.action === action)!.requiresReauth;
    expect(reauth("complete_polls")).toBe(true);
    expect(reauth("freeze")).toBe(true);
  });
});

describe("Booth transition table", () => {
  it("allows exactly the listed (state, action) pairs and nothing else", () => {
    const allowed = new Set<string>();
    for (const state of BOOTH_STATES) {
      for (const action of BOOTH_ACTIONS) {
        const row = findTransition(BOOTH_TRANSITIONS, state, action);
        if (row) allowed.add(`${state}/${action}>${row.to}`);
      }
    }
    expect(allowed).toEqual(EXPECTED_BOOTH);
    expect(BOOTH_STATES.length * BOOTH_ACTIONS.length).toBe(42);
  });

  it("never lets a Closed or Sealed booth return to Open or any earlier state", () => {
    const order = BOOTH_STATES as readonly string[];
    for (const row of BOOTH_TRANSITIONS) {
      if (row.from === "closed" || row.from === "sealed") {
        expect(order.indexOf(row.to)).toBeGreaterThan(order.indexOf(row.from));
      }
    }
    expect(BOOTH_TRANSITIONS.filter((r) => r.from === "sealed")).toEqual([]);
  });

  it("lets a mock poll be repeated (Mock Cleared → Mock Poll)", () => {
    expect(findTransition(BOOTH_TRANSITIONS, "mock_cleared", "repeat_mock_poll")).toMatchObject({
      to: "mock_poll",
      allowedRoles: ["presiding_officer"],
    });
  });

  it("gives close to the Presiding Officer, force close to the Returning Officer with a reason", () => {
    expect(findTransition(BOOTH_TRANSITIONS, "open", "close_poll")).toMatchObject({
      allowedRoles: ["presiding_officer"],
      requiresReauth: true,
    });
    expect(findTransition(BOOTH_TRANSITIONS, "open", "force_close_poll")).toMatchObject({
      allowedRoles: ["returning_officer"],
      requiresReauth: true,
      requiresReason: true,
    });
  });

  it("opens a poll only behind every required guard, with re-authentication", () => {
    const row = findTransition(BOOTH_TRANSITIONS, "mock_cleared", "open_poll")!;
    expect([...row.guards].sort()).toEqual(
      ["electionPollingOpen", "noPendingBallot", "votingTerminalOnline", "zeroRealBallots"].sort(),
    );
    expect(row.requiresReauth).toBe(true);
  });

  it("seals only as part of completing all polls (system, never a staff role)", () => {
    expect(findTransition(BOOTH_TRANSITIONS, "closed", "seal")!.allowedRoles).toEqual(["system"]);
  });
});

describe("pairsOf", () => {
  it("lists distinct (from, to) pairs", () => {
    expect(pairsOf(BOOTH_TRANSITIONS)).toContain("open>closed");
    expect(pairsOf(BOOTH_TRANSITIONS).filter((p) => p === "open>closed")).toHaveLength(1);
  });
});

describe("guard registry", () => {
  const ctx = {} as GuardContext;

  it("blocks a transition whose guard is not registered (fails closed)", async () => {
    const { failures } = await runGuards(["noPendingBallot"], {}, ctx);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("noPendingBallot");
  });

  it("passes when every guard passes, and collects audit data from guards", async () => {
    const registry: GuardRegistry = {
      noPendingBallot: async () => pass(),
      mockBallotCast: async () => pass({ mock_ballots: 3 }),
    };
    expect(await runGuards(["noPendingBallot", "mockBallotCast"], registry, ctx)).toEqual({
      failures: [],
      audit: { mockBallotCast: { mock_ballots: 3 } },
    });
  });

  it("runs every guard so all reasons are reported together", async () => {
    const registry: GuardRegistry = {
      noPendingBallot: async () => fail("a Ballot Session is pending"),
      votingTerminalOnline: async () => fail("the Voting Terminal is offline"),
      zeroRealBallots: async () => pass(),
    };
    const { failures } = await runGuards(
      ["noPendingBallot", "zeroRealBallots", "votingTerminalOnline", "resultsReady"],
      registry,
      ctx,
    );
    expect(failures).toHaveLength(3); // two failures plus the unregistered guard
  });
});
