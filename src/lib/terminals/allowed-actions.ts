import {
  BOOTH_TRANSITIONS,
  findTransition,
  type BoothAction,
  type BoothState,
  type GuardName,
} from "@/lib/lifecycle/tables";

/**
 * What the Presiding Officer's Master Terminal may offer right now, computed on the server from
 * the transition table and the booth's facts. The screen only renders this list; it never
 * re-implements a rule. Every refusal carries the reason the screen shows next to the control.
 * The commands still validate everything again when an action is actually sent.
 */

export type MasterAction =
  | "issue_ballot"
  | "cancel_ballot"
  | Extract<
      BoothAction,
      "start_mock_poll" | "clear_mock_poll" | "repeat_mock_poll" | "open_poll" | "close_poll"
    >;

export const MASTER_ACTIONS: readonly MasterAction[] = [
  "issue_ballot",
  "cancel_ballot",
  "start_mock_poll",
  "clear_mock_poll",
  "repeat_mock_poll",
  "open_poll",
  "close_poll",
];

export interface AllowedAction {
  action: MasterAction;
  allowed: boolean;
  /** Why the action is unavailable (null when allowed). */
  reason: string | null;
}

export interface ActionFacts {
  boothState: string;
  electionStatus: string;
  ballotPending: boolean;
  masterActive: boolean;
  votingPaired: boolean;
  votingOnline: boolean;
  realBallotsCast: number;
  mockBallotsCast: number;
}

type Check = (facts: ActionFacts) => string | null;

/** The guard names of the transition table, answered from the booth's facts. */
const GUARD_CHECKS: Record<GuardName, Check> = {
  electionFrozenOrOpen: (f) =>
    f.electionStatus === "frozen" || f.electionStatus === "polling_open"
      ? null
      : "The Election must be Frozen or Polling Open",
  electionPollingOpen: (f) =>
    f.electionStatus === "polling_open" ? null : "The Election is not Polling Open yet",
  masterTerminalActive: (f) => (f.masterActive ? null : "This device is not the Master Terminal"),
  votingTerminalActive: (f) => (f.votingPaired ? null : "No Voting Terminal is paired"),
  votingTerminalOnline: (f) =>
    !f.votingPaired
      ? "No Voting Terminal is paired"
      : f.votingOnline
        ? null
        : "The Voting Terminal is offline",
  noPendingBallot: (f) => (f.ballotPending ? "A ballot is pending: wait or cancel" : null),
  mockBallotCast: (f) =>
    f.mockBallotsCast > 0 ? null : "Cast at least one mock ballot before clearing the mock poll",
  zeroRealBallots: (f) =>
    f.realBallotsCast === 0 ? null : "Real ballots have already been cast at this booth",
  // Booth-level actions never depend on these.
  allBoothsClosed: () => null,
  resultsReady: () => null,
};

const BOOTH_ACTION_LABEL: Record<string, string> = {
  start_mock_poll: "Start mock poll",
  clear_mock_poll: "Clear mock poll",
  repeat_mock_poll: "Repeat mock poll",
  open_poll: "Open poll",
  close_poll: "Close poll",
};

const stateLabel = (state: string) => state.replace(/_/g, " ");

function boothAction(action: BoothAction, f: ActionFacts): AllowedAction {
  const row = findTransition(BOOTH_TRANSITIONS, f.boothState as BoothState, action);
  if (!row || !row.allowedRoles.includes("presiding_officer")) {
    return {
      action: action as MasterAction,
      allowed: false,
      reason: `${BOOTH_ACTION_LABEL[action] ?? action} is not available while the booth is ${stateLabel(f.boothState)}`,
    };
  }
  for (const guard of row.guards) {
    const reason = GUARD_CHECKS[guard](f);
    if (reason) return { action: action as MasterAction, allowed: false, reason };
  }
  return { action: action as MasterAction, allowed: true, reason: null };
}

function issueBallot(f: ActionFacts): AllowedAction {
  const deny = (reason: string): AllowedAction => ({
    action: "issue_ballot",
    allowed: false,
    reason,
  });
  if (f.boothState !== "open" && f.boothState !== "mock_poll") {
    return deny(`Ballots can be issued only while the poll is open or in a mock poll`);
  }
  if (f.boothState === "open" && f.electionStatus !== "polling_open") {
    return deny("The Election is not Polling Open");
  }
  if (!f.votingPaired) return deny("No Voting Terminal is paired");
  if (!f.votingOnline) return deny("The Voting Terminal is offline");
  if (f.ballotPending) return deny("A ballot is already pending");
  return { action: "issue_ballot", allowed: true, reason: null };
}

function cancelBallot(f: ActionFacts): AllowedAction {
  return f.ballotPending
    ? { action: "cancel_ballot", allowed: true, reason: null }
    : { action: "cancel_ballot", allowed: false, reason: "There is no pending ballot to cancel" };
}

export function computeAllowedActions(facts: ActionFacts): AllowedAction[] {
  return [
    issueBallot(facts),
    cancelBallot(facts),
    boothAction("start_mock_poll", facts),
    boothAction("clear_mock_poll", facts),
    boothAction("repeat_mock_poll", facts),
    boothAction("open_poll", facts),
    boothAction("close_poll", facts),
  ];
}
