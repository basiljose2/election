import type { StaffRole } from "@/lib/auth/roles";

/**
 * The only permitted Election and Polling Booth transitions, as data. The transition engine
 * (engine.ts) executes exactly these rows; the SQL triggers hold a copy of the (from, to)
 * pairs, and tests/integration/lifecycle-tables.test.ts fails if the two ever differ.
 */

export const ELECTION_STATES = [
  "draft",
  "frozen",
  "polling_open",
  "polling_completed",
  "results_declared",
  "archived",
] as const;
export type ElectionState = (typeof ELECTION_STATES)[number];

export const BOOTH_STATES = [
  "setup",
  "mock_poll",
  "mock_cleared",
  "open",
  "closed",
  "sealed",
] as const;
export type BoothState = (typeof BOOTH_STATES)[number];

/** Names of the checks a transition runs. Owners register them in the guard registry. */
export type GuardName =
  // election-state-machines
  | "electionFrozenOrOpen"
  | "electionPollingOpen"
  | "allBoothsClosed"
  // realtime-device-pairing
  | "masterTerminalActive"
  | "votingTerminalActive"
  | "votingTerminalOnline"
  // ballot-casting-core
  | "noPendingBallot"
  | "mockBallotCast"
  | "zeroRealBallots"
  // results-dashboard
  | "resultsReady";

/** Who may run a transition. `system` transitions only happen as part of another one. */
export type TransitionActor = StaffRole | "system";

export interface TransitionRow<S extends string, A extends string> {
  from: S;
  to: S;
  action: A;
  allowedRoles: readonly TransitionActor[];
  guards: readonly GuardName[];
  requiresReauth: boolean;
  /** The input must carry a written reason (force close). */
  requiresReason?: boolean;
  /**
   * Which change implements the command. `election-setup` owns freeze/unfreeze (they build
   * the Ballot Definitions); they are listed here so the table is the complete picture.
   */
  owner: "engine" | "election-setup";
}

export type ElectionAction =
  "freeze" | "unfreeze" | "start_polling" | "complete_polls" | "declare_results" | "archive";

export type BoothAction =
  | "start_mock_poll"
  | "clear_mock_poll"
  | "repeat_mock_poll"
  | "open_poll"
  | "close_poll"
  | "force_close_poll"
  | "seal";

export const ELECTION_TRANSITIONS: readonly TransitionRow<ElectionState, ElectionAction>[] = [
  {
    from: "draft",
    to: "frozen",
    action: "freeze",
    allowedRoles: ["returning_officer"],
    guards: [],
    requiresReauth: true,
    owner: "election-setup",
  },
  {
    from: "frozen",
    to: "draft",
    action: "unfreeze",
    allowedRoles: ["returning_officer"],
    guards: [],
    requiresReauth: true,
    owner: "election-setup",
  },
  {
    from: "frozen",
    to: "polling_open",
    action: "start_polling",
    allowedRoles: ["returning_officer"],
    guards: [],
    requiresReauth: false,
    owner: "engine",
  },
  {
    from: "polling_open",
    to: "polling_completed",
    action: "complete_polls",
    allowedRoles: ["returning_officer"],
    guards: ["allBoothsClosed"],
    requiresReauth: true,
    owner: "engine",
  },
  {
    from: "polling_completed",
    to: "results_declared",
    action: "declare_results",
    allowedRoles: ["returning_officer"],
    guards: ["resultsReady"],
    requiresReauth: true,
    owner: "engine",
  },
  {
    from: "results_declared",
    to: "archived",
    action: "archive",
    allowedRoles: ["super_admin"],
    guards: [],
    requiresReauth: true,
    owner: "engine",
  },
];

const START_MOCK_GUARDS: readonly GuardName[] = [
  "electionFrozenOrOpen",
  "masterTerminalActive",
  "votingTerminalActive",
];

export const BOOTH_TRANSITIONS: readonly TransitionRow<BoothState, BoothAction>[] = [
  {
    from: "setup",
    to: "mock_poll",
    action: "start_mock_poll",
    allowedRoles: ["presiding_officer"],
    guards: START_MOCK_GUARDS,
    requiresReauth: false,
    owner: "engine",
  },
  {
    from: "mock_poll",
    to: "mock_cleared",
    action: "clear_mock_poll",
    allowedRoles: ["presiding_officer"],
    guards: ["mockBallotCast", "noPendingBallot"],
    requiresReauth: false,
    owner: "engine",
  },
  {
    from: "mock_cleared",
    to: "mock_poll",
    action: "repeat_mock_poll",
    allowedRoles: ["presiding_officer"],
    guards: START_MOCK_GUARDS,
    requiresReauth: false,
    owner: "engine",
  },
  {
    from: "mock_cleared",
    to: "open",
    action: "open_poll",
    allowedRoles: ["presiding_officer"],
    guards: ["electionPollingOpen", "noPendingBallot", "zeroRealBallots", "votingTerminalOnline"],
    requiresReauth: true,
    owner: "engine",
  },
  {
    from: "open",
    to: "closed",
    action: "close_poll",
    allowedRoles: ["presiding_officer"],
    guards: ["noPendingBallot"],
    requiresReauth: true,
    owner: "engine",
  },
  {
    from: "open",
    to: "closed",
    action: "force_close_poll",
    allowedRoles: ["returning_officer"],
    guards: [],
    requiresReauth: true,
    requiresReason: true,
    owner: "engine",
  },
  {
    from: "closed",
    to: "sealed",
    action: "seal",
    allowedRoles: ["system"],
    guards: [],
    requiresReauth: false,
    owner: "engine",
  },
];

export function findTransition<S extends string, A extends string>(
  table: readonly TransitionRow<S, A>[],
  from: S,
  action: A,
): TransitionRow<S, A> | undefined {
  return table.find((row) => row.from === from && row.action === action);
}

/** The (from, to) pairs, as stored in the SQL transition tables. */
export const pairsOf = <S extends string, A extends string>(
  table: readonly TransitionRow<S, A>[],
): string[] => [...new Set(table.map((row) => `${row.from}>${row.to}`))].sort();
