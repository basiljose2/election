import { isPrivileged, type Actor, type RoleAssignment } from "./roles";

export const STAFF_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const MASTER_TERMINAL_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const REAUTH_WINDOW_MS = 5 * 60 * 1000;

export type SessionKind = "staff" | "master_terminal";

/**
 * 30 minutes for staff sessions. A Presiding Officer session on a paired Master Terminal
 * (kind set by device pairing) gets 12 hours; any other holder of that kind gets 30 minutes.
 */
export function idleTimeoutMs(kind: SessionKind, roles: readonly RoleAssignment[]): number {
  const isPresidingOfficer = roles.some((r) => r.role === "presiding_officer");
  return kind === "master_terminal" && isPresidingOfficer
    ? MASTER_TERMINAL_IDLE_TIMEOUT_MS
    : STAFF_IDLE_TIMEOUT_MS;
}

export function isIdleExpired(lastSeenAt: Date, now: Date, timeoutMs: number): boolean {
  return now.getTime() - lastSeenAt.getTime() >= timeoutMs;
}

function withinWindow(epochSeconds: number | null, now: Date): boolean {
  if (epochSeconds === null) return false;
  const age = now.getTime() - epochSeconds * 1000;
  return age >= -60_000 && age <= REAUTH_WINDOW_MS; // tolerate one minute of clock skew
}

/**
 * Critical actions need a password entry (and, for privileged roles, a TOTP code)
 * within the last 5 minutes.
 */
export function hasRecentAuth(actor: Pick<Actor, "roles" | "authTimes">, now: Date): boolean {
  if (!withinWindow(actor.authTimes.password, now)) return false;
  return !isPrivileged(actor) || withinWindow(actor.authTimes.totp, now);
}
