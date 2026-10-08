import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import {
  signInWithPassword,
  type Authenticator,
  type PasswordCheck,
  type SignInDeps,
} from "@/lib/auth/signin";
import { adminPool, appPool, auditEvents, createStaffFixture } from "../support/fixtures";

const app = appPool();
const admin = adminPool();
afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

function authenticator(check: () => PasswordCheck): Authenticator & {
  signInWithPassword: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
} {
  return {
    signInWithPassword: vi.fn(async () => check()),
    signOut: vi.fn(async () => undefined),
  };
}

function deps(auth: Authenticator, now: () => Date = () => new Date()): SignInDeps {
  return { db: app, now, authenticator: auth, appendAudit: appendAuditEvent };
}

describe("sign-in rate limiting", () => {
  it("blocks and audits the 6th attempt after 5 failures in 15 minutes", async () => {
    const email = `${randomUUID()}@fixture.test`;
    const auth = authenticator(() => ({ ok: false }));

    for (let i = 0; i < 5; i++) {
      expect(await signInWithPassword(email, "wrong-password", deps(auth))).toEqual({
        status: "invalid",
      });
    }
    expect(await signInWithPassword(email, "right-password", deps(auth))).toEqual({
      status: "locked",
    });

    // The 6th attempt never reached Supabase Auth.
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(5);

    const events = await auditEvents(app, { electionId: null, targetId: email });
    expect(events.map((e) => e.payload.event_type)).toEqual([
      "auth.signin_failed",
      "auth.signin_failed",
      "auth.signin_failed",
      "auth.signin_failed",
      "auth.signin_failed",
      "auth.account_locked",
      "auth.signin_blocked",
    ]);
  });

  it("normalises the account key so case changes do not bypass the limit", async () => {
    const email = `${randomUUID()}@fixture.test`;
    const auth = authenticator(() => ({ ok: false }));
    for (let i = 0; i < 5; i++) await signInWithPassword(email, "x", deps(auth));
    expect((await signInWithPassword(`  ${email.toUpperCase()} `, "x", deps(auth))).status).toBe(
      "locked",
    );
  });

  it("keeps the account locked for 15 minutes, then allows attempts again", async () => {
    const email = `${randomUUID()}@fixture.test`;
    const auth = authenticator(() => ({ ok: false }));
    const start = Date.now();
    let offset = 0;
    const clock = () => new Date(start + offset);

    for (let i = 0; i < 5; i++) await signInWithPassword(email, "x", deps(auth, clock));

    offset = 14 * 60 * 1000;
    expect((await signInWithPassword(email, "x", deps(auth, clock))).status).toBe("locked");

    offset = 15 * 60 * 1000 + 1000;
    expect((await signInWithPassword(email, "x", deps(auth, clock))).status).toBe("invalid");
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(6);
  });

  it("counts parallel in-flight attempts so a burst cannot exceed the limit", async () => {
    const email = `${randomUUID()}@fixture.test`;
    const auth = authenticator(() => ({ ok: false }));
    const results = await Promise.all(
      Array.from({ length: 12 }, () => signInWithPassword(email, "x", deps(auth))),
    );
    expect(auth.signInWithPassword.mock.calls.length).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === "locked").length).toBeGreaterThanOrEqual(7);
  });
});

describe("sign-in outcomes", () => {
  it("starts a tracked session and audits a successful sign-in", async () => {
    const staff = await createStaffFixture(admin, [{ role: "observer", electionId: randomUUID() }]);
    const sessionId = randomUUID();
    const auth = authenticator(() => ({ ok: true, userId: staff.userId, sessionId }));

    expect(await signInWithPassword(staff.email, "pw", deps(auth))).toEqual({
      status: "ok",
      userId: staff.userId,
      sessionId,
    });
    const session = await app.query(
      "select kind, ended_at from public.staff_sessions where session_id = $1",
      [sessionId],
    );
    expect(session.rows[0]).toEqual({ kind: "staff", ended_at: null });
    const events = await auditEvents(app, {
      electionId: null,
      eventType: "auth.signed_in",
      actorId: staff.userId,
    });
    expect(events).toHaveLength(1);
  });

  it("rejects a deactivated account even with the correct password", async () => {
    const staff = await createStaffFixture(admin, [], { active: false });
    const auth = authenticator(() => ({ ok: true, userId: staff.userId, sessionId: randomUUID() }));

    expect(await signInWithPassword(staff.email, "pw", deps(auth))).toEqual({ status: "invalid" });
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    const events = await auditEvents(app, {
      electionId: null,
      eventType: "auth.signin_failed",
      actorId: staff.userId,
    });
    expect(events[0]!.payload.detail).toEqual({ reason: "account_deactivated" });
  });
});
