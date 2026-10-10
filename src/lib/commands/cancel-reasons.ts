/** Reasons a Presiding Officer may give for cancelling a pending ballot (safe for client code). */
export const CANCEL_REASONS = ["voter_left", "voter_refused", "terminal_fault"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export const CANCEL_REASON_LABELS: Record<CancelReason, string> = {
  voter_left: "Voter left without voting",
  voter_refused: "Voter refused to vote",
  terminal_fault: "Terminal fault",
};
