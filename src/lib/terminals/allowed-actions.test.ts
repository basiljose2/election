import { describe, expect, it } from "vitest";
import { BOOTH_STATES } from "@/lib/lifecycle/tables";
import {
  computeAllowedActions,
  MASTER_ACTIONS,
  type ActionFacts,
  type MasterAction,
} from "./allowed-actions";

const facts = (overrides: Partial<ActionFacts> = {}): ActionFacts => ({
  boothState: "setup",
  electionStatus: "polling_open",
  ballotPending: false,
  masterActive: true,
  votingPaired: true,
  votingOnline: true,
  realBallotsCast: 0,
  mockBallotsCast: 0,
  ...overrides,
});

function allowed(f: ActionFacts): MasterAction[] {
  return computeAllowedActions(f)
    .filter((a) => a.allowed)
    .map((a) => a.action);
}

function reason(f: ActionFacts, action: MasterAction): string | null {
  return computeAllowedActions(f).find((a) => a.action === action)!.reason;
}

describe("allowedActions", () => {
  it("lists every action exactly once, each refusal with a reason", () => {
    for (const state of BOOTH_STATES) {
      const list = computeAllowedActions(facts({ boothState: state }));
      expect(list.map((a) => a.action)).toEqual([...MASTER_ACTIONS]);
      for (const a of list) expect(a.allowed).toBe(a.reason === null);
    }
  });

  it("setup: only a mock poll can be started", () => {
    expect(allowed(facts({ boothState: "setup" }))).toEqual(["start_mock_poll"]);
  });

  it("setup: starting the mock poll needs a paired Voting Terminal", () => {
    const f = facts({ boothState: "setup", votingPaired: false, votingOnline: false });
    expect(allowed(f)).toEqual([]);
    expect(reason(f, "start_mock_poll")).toBe("No Voting Terminal is paired");
  });

  it("mock_poll: ballots can be issued; clearing needs a cast mock ballot", () => {
    const none = facts({ boothState: "mock_poll" });
    expect(allowed(none)).toEqual(["issue_ballot"]);
    expect(reason(none, "clear_mock_poll")).toMatch(/at least one mock ballot/);

    const some = facts({ boothState: "mock_poll", mockBallotsCast: 3 });
    expect(allowed(some)).toEqual(["issue_ballot", "clear_mock_poll"]);
  });

  it("mock_poll with a pending ballot: cancel only, clear blocked with the reason", () => {
    const f = facts({ boothState: "mock_poll", ballotPending: true, mockBallotsCast: 2 });
    expect(allowed(f)).toEqual(["cancel_ballot"]);
    expect(reason(f, "clear_mock_poll")).toBe("A ballot is pending: wait or cancel");
    expect(reason(f, "issue_ballot")).toBe("A ballot is already pending");
  });

  it("mock_cleared: repeat or open", () => {
    expect(allowed(facts({ boothState: "mock_cleared" }))).toEqual([
      "repeat_mock_poll",
      "open_poll",
    ]);
  });

  it("mock_cleared: open waits for the Election to be Polling Open", () => {
    const f = facts({ boothState: "mock_cleared", electionStatus: "frozen" });
    expect(allowed(f)).toEqual(["repeat_mock_poll"]);
    expect(reason(f, "open_poll")).toBe("The Election is not Polling Open yet");
  });

  it("mock_cleared: open needs the Voting Terminal online", () => {
    const f = facts({ boothState: "mock_cleared", votingOnline: false });
    expect(reason(f, "open_poll")).toBe("The Voting Terminal is offline");
  });

  it("open: ballot, then close; close is blocked while a ballot is pending", () => {
    expect(allowed(facts({ boothState: "open" }))).toEqual(["issue_ballot", "close_poll"]);

    const pending = facts({ boothState: "open", ballotPending: true });
    expect(allowed(pending)).toEqual(["cancel_ballot"]);
    expect(reason(pending, "close_poll")).toBe("A ballot is pending: wait or cancel");
  });

  it("open: an offline Voting Terminal blocks ballots but not closing", () => {
    const f = facts({ boothState: "open", votingOnline: false });
    expect(allowed(f)).toEqual(["close_poll"]);
    expect(reason(f, "issue_ballot")).toBe("The Voting Terminal is offline");
  });

  it("closed and sealed: nothing is available", () => {
    expect(allowed(facts({ boothState: "closed" }))).toEqual([]);
    expect(allowed(facts({ boothState: "sealed" }))).toEqual([]);
  });
});
