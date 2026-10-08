import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { appendAuditEvent } from "@/lib/audit/append";
import { actorForCommand, resolveActor, type VerifiedClaims } from "@/lib/auth/resolve-actor";
import { electionGrant } from "@/lib/auth/roles";
import { CommandError } from "@/lib/commands/errors";
import { defineCommand, executeCommand } from "@/lib/commands/gateway";
import {
  adminPool,
  appPool,
  auditEvents,
  createStaffFixture,
  type RoleSpec,
} from "../support/fixtures";

const app = appPool();
const admin = adminPool();
afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const T0 = new Date("2026-10-01T08:00:00.000Z");
const MINUTE = 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const deps = { db: app, now: () => new Date(), appendAudit: appendAuditEvent };

/** A signed-in staff member with a tracked session, as the sign-in service creates it. */
async function signedIn(
  roles: RoleSpec[],
  kind: "staff" | "master_terminal" = "staff",
  aal = "aal1",
) {
  const staff = await createStaffFixture(admin, roles);
  const sessionId = randomUUID();
  await app.query(
    `insert into public.staff_sessions (session_id, user_id, kind, created_at, last_seen_at)
     values ($1, $2, $3, $4, $4)`,
    [sessionId, staff.userId, kind, new Date()],
  );
  const seconds = Math.floor(Date.now() / 1000);
  const claims: VerifiedClaims = {
    sub: staff.userId,
    session_id: sessionId,
    aal,
    amr:
      aal === "aal2"
        ? [
            { method: "totp", timestamp: seconds },
            { method: "password", timestamp: seconds },
          ]
        : [{ method: "password", timestamp: seconds }],
  };
  return { staff, sessionId, claims };
}

describe("idle timeout (clock mocked)", () => {
  it("keeps a staff session alive while it is used within 30 minutes", async () => {
    const { claims } = await signedIn([{ role: "observer", electionId: randomUUID() }]);
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(new Date(Date.now() + 29 * MINUTE));
      expect((await resolveActor(claims, deps)).status).toBe("ok");
    }
  });

  it("rejects the next request after 30 idle minutes and requires a new sign-in", async () => {
    const { claims, sessionId, staff } = await signedIn(
      [{ role: "returning_officer", electionId: randomUUID() }],
      "staff",
      "aal2",
    );

    vi.setSystemTime(new Date(T0.getTime() + 30 * MINUTE));
    expect((await resolveActor(claims, deps)).status).toBe("idle_timeout");

    // The session stays ended even if the user comes back straight away.
    vi.setSystemTime(new Date(T0.getTime() + 31 * MINUTE));
    expect((await resolveActor(claims, deps)).status).toBe("session_ended");

    const row = await app.query(
      "select end_reason from public.staff_sessions where session_id = $1",
      [sessionId],
    );
    expect(row.rows[0]).toEqual({ end_reason: "idle_timeout" });
    expect(
      await auditEvents(app, {
        electionId: null,
        eventType: "auth.session_idle_timeout",
        actorId: staff.userId,
      }),
    ).toHaveLength(1);
  });

  it("gives a Presiding Officer on a Master Terminal 12 hours", async () => {
    const po: RoleSpec = {
      role: "presiding_officer",
      electionId: randomUUID(),
      boothId: randomUUID(),
    };
    const { claims } = await signedIn([po], "master_terminal");

    vi.setSystemTime(new Date(T0.getTime() + 11 * 60 * MINUTE + 59 * MINUTE));
    expect((await resolveActor(claims, deps)).status).toBe("ok");

    vi.setSystemTime(new Date(Date.now() + 12 * 60 * MINUTE));
    expect((await resolveActor(claims, deps)).status).toBe("idle_timeout");
  });

  it("gives the same Presiding Officer 30 minutes on an ordinary session", async () => {
    const po: RoleSpec = {
      role: "presiding_officer",
      electionId: randomUUID(),
      boothId: randomUUID(),
    };
    const { claims } = await signedIn([po], "staff");
    vi.setSystemTime(new Date(T0.getTime() + 31 * MINUTE));
    expect((await resolveActor(claims, deps)).status).toBe("idle_timeout");
  });

  it("does not extend the Master Terminal timeout to non-PO sessions", async () => {
    const { claims } = await signedIn(
      [{ role: "observer", electionId: randomUUID() }],
      "master_terminal",
    );
    vi.setSystemTime(new Date(T0.getTime() + 31 * MINUTE));
    expect((await resolveActor(claims, deps)).status).toBe("idle_timeout");
  });
});

describe("session validity", () => {
  it("rejects a session that was not started by the app's sign-in", async () => {
    const { claims } = await signedIn([{ role: "observer", electionId: randomUUID() }]);
    expect((await resolveActor({ ...claims, session_id: randomUUID() }, deps)).status).toBe(
      "unauthenticated",
    );
  });

  it("rejects and ends the sessions of a deactivated account", async () => {
    const { claims, staff, sessionId } = await signedIn([
      { role: "observer", electionId: randomUUID() },
    ]);
    await admin.query(
      "update public.staff set active = false, deactivated_at = now() where user_id = $1",
      [staff.userId],
    );
    expect((await resolveActor(claims, deps)).status).toBe("inactive");
    const row = await app.query(
      "select end_reason from public.staff_sessions where session_id = $1",
      [sessionId],
    );
    expect(row.rows[0]).toEqual({ end_reason: "deactivated" });
  });
});

describe("mandatory MFA for privileged roles", () => {
  const roAction = defineCommand({
    name: "test.ro_action",
    input: z.object({ electionId: z.uuid() }),
    authorize: (actor, input) => electionGrant(actor, input.electionId, ["returning_officer"]),
    describeTarget: (input) => ({
      electionId: input.electionId,
      target: { type: "election", id: input.electionId },
    }),
    async execute(_ctx, input) {
      return {
        result: "ok",
        audit: {
          electionId: input.electionId,
          target: { type: "election", id: input.electionId },
          before: null,
          after: null,
        },
      };
    },
  });

  it("denies a Returning Officer who has not completed the TOTP challenge", async () => {
    const electionId = randomUUID();
    const { claims } = await signedIn([{ role: "returning_officer", electionId }], "staff", "aal1");

    const resolution = await resolveActor(claims, deps);
    expect(resolution.status).toBe("mfa_required");
    expect(() => actorForCommand(resolution)).toThrow(CommandError);

    await expect(
      executeCommand(
        roAction,
        { electionId },
        {
          db: app,
          now: () => new Date(),
          authenticate: async () => actorForCommand(await resolveActor(claims, deps)),
          appendAudit: appendAuditEvent,
        },
      ),
    ).rejects.toSatisfy((e: unknown) => e instanceof CommandError && e.code === "mfa_required");
    expect(await auditEvents(app, { electionId })).toHaveLength(0);
  });

  it("allows the same Returning Officer at aal2", async () => {
    const electionId = randomUUID();
    const { claims } = await signedIn([{ role: "returning_officer", electionId }], "staff", "aal2");
    await expect(
      executeCommand(
        roAction,
        { electionId },
        {
          db: app,
          now: () => new Date(),
          authenticate: async () => actorForCommand(await resolveActor(claims, deps)),
          appendAudit: appendAuditEvent,
        },
      ),
    ).resolves.toBe("ok");
  });

  it("requires MFA for a Super Admin but not for a Presiding Officer", async () => {
    const sa = await signedIn([{ role: "super_admin" }], "staff", "aal1");
    expect((await resolveActor(sa.claims, deps)).status).toBe("mfa_required");

    const po = await signedIn(
      [{ role: "presiding_officer", electionId: randomUUID(), boothId: randomUUID() }],
      "staff",
      "aal1",
    );
    expect((await resolveActor(po.claims, deps)).status).toBe("ok");
  });
});
