import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleAssignment } from "./roles";
import {
  hasRecentAuth,
  idleTimeoutMs,
  isIdleExpired,
  MASTER_TERMINAL_IDLE_TIMEOUT_MS,
  STAFF_IDLE_TIMEOUT_MS,
} from "./session-policy";

const po: RoleAssignment = { id: "1", role: "presiding_officer", electionId: "e", boothId: "b" };
const ro: RoleAssignment = { id: "2", role: "returning_officer", electionId: "e", boothId: null };
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T08:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("idle timeout policy", () => {
  it("is 30 minutes for staff and 12 hours for a PO on a Master Terminal", () => {
    expect(idleTimeoutMs("staff", [ro])).toBe(STAFF_IDLE_TIMEOUT_MS);
    expect(idleTimeoutMs("staff", [po])).toBe(STAFF_IDLE_TIMEOUT_MS);
    expect(idleTimeoutMs("master_terminal", [po])).toBe(MASTER_TERMINAL_IDLE_TIMEOUT_MS);
    expect(idleTimeoutMs("master_terminal", [ro])).toBe(STAFF_IDLE_TIMEOUT_MS);
  });

  it("expires exactly at the timeout", () => {
    const lastSeen = new Date();
    vi.advanceTimersByTime(30 * MINUTE - 1);
    expect(isIdleExpired(lastSeen, new Date(), STAFF_IDLE_TIMEOUT_MS)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(isIdleExpired(lastSeen, new Date(), STAFF_IDLE_TIMEOUT_MS)).toBe(true);
  });
});

describe("re-authentication window", () => {
  const seconds = () => Math.floor(Date.now() / 1000);

  it("accepts a password entered within 5 minutes for a non-privileged role", () => {
    const actor = { roles: [po], authTimes: { password: seconds(), totp: null } };
    vi.advanceTimersByTime(5 * MINUTE);
    expect(hasRecentAuth(actor, new Date())).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(hasRecentAuth(actor, new Date())).toBe(false);
  });

  it("also requires a recent TOTP code for privileged roles", () => {
    const now = seconds();
    expect(
      hasRecentAuth({ roles: [ro], authTimes: { password: now, totp: null } }, new Date()),
    ).toBe(false);
    expect(
      hasRecentAuth({ roles: [ro], authTimes: { password: now, totp: now - 6 * 60 } }, new Date()),
    ).toBe(false);
    expect(
      hasRecentAuth({ roles: [ro], authTimes: { password: now, totp: now } }, new Date()),
    ).toBe(true);
  });

  it("rejects a missing or far-future timestamp", () => {
    expect(
      hasRecentAuth({ roles: [po], authTimes: { password: null, totp: null } }, new Date()),
    ).toBe(false);
    expect(
      hasRecentAuth(
        { roles: [po], authTimes: { password: seconds() + 3600, totp: null } },
        new Date(),
      ),
    ).toBe(false);
  });
});
