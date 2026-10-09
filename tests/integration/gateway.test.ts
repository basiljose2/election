import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { appendAuditEvent, type AppendAuditEvent } from "@/lib/audit/append";
import { boothGrant, type Actor } from "@/lib/auth/roles";
import { CommandError } from "@/lib/commands/errors";
import { defineCommand, executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { createStaffCommands, type AuthAdmin } from "@/lib/commands/staff";
import {
  actorFor,
  adminPool,
  appPool,
  auditEvents,
  createStaffFixture,
  ensureBooth,
  ensureElection,
} from "../support/fixtures";

const app = appPool();
const admin = adminPool();

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

/** Auth admin double that creates real auth.users rows so foreign keys hold. */
function fakeAuthAdmin(): AuthAdmin & { deleted: string[]; banned: string[] } {
  const deleted: string[] = [];
  const banned: string[] = [];
  return {
    deleted,
    banned,
    async createUser(email) {
      const userId = randomUUID();
      await admin.query("insert into auth.users (id, email) values ($1, $2)", [userId, email]);
      return { userId };
    },
    async deleteUser(userId) {
      deleted.push(userId);
    },
    async banUser(userId) {
      banned.push(userId);
    },
  };
}

function deps(actor: Actor, overrides: Partial<GatewayDeps> = {}): Partial<GatewayDeps> {
  return {
    db: app,
    now: () => new Date(),
    authenticate: async () => actor,
    appendAudit: appendAuditEvent,
    ...overrides,
  };
}

async function expectCommandError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof CommandError && e.code === code,
  );
}

describe("command gateway", () => {
  let superAdmin: Actor;
  let target: Awaited<ReturnType<typeof createStaffFixture>>;

  beforeAll(async () => {
    superAdmin = actorFor(await createStaffFixture(admin, [{ role: "super_admin" }]));
    target = await createStaffFixture(admin, []);
  });

  it("commits the change and exactly one Audit Event", async () => {
    const { assignRole } = createStaffCommands(fakeAuthAdmin());
    const electionId = randomUUID();
    await ensureElection(admin, electionId);
    const { assignmentId } = await executeCommand(
      assignRole,
      { userId: target.userId, role: "observer", electionId },
      deps(superAdmin),
    );

    const events = await auditEvents(app, { electionId, targetId: assignmentId });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      event_type: "staff.role_assigned",
      actor: { user_id: superAdmin.userId, role: "super_admin", terminal_id: null },
      target: { type: "staff_role", id: assignmentId },
      before: null,
      after: { user_id: target.userId, role: "observer", election_id: electionId, booth_id: null },
    });
  });

  it("rolls back the change when the Audit Event cannot be written", async () => {
    const { assignRole } = createStaffCommands(fakeAuthAdmin());
    const electionId = randomUUID();
    await ensureElection(admin, electionId);
    const failingAudit: AppendAuditEvent = async () => {
      throw new Error("injected audit failure");
    };

    await expect(
      executeCommand(
        assignRole,
        { userId: target.userId, role: "returning_officer", electionId },
        deps(superAdmin, { appendAudit: failingAudit }),
      ),
    ).rejects.toThrow("injected audit failure");

    const rows = await app.query(
      "select 1 from public.staff_roles where user_id = $1 and election_id = $2",
      [target.userId, electionId],
    );
    expect(rows.rowCount).toBe(0);
    expect(await auditEvents(app, { electionId })).toHaveLength(0);
  });

  it("rolls back when the database rejects the Audit Event after it was sent", async () => {
    const { assignRole } = createStaffCommands(fakeAuthAdmin());
    const electionId = randomUUID();
    await ensureElection(admin, electionId);
    // Writes a real event, then a second one that breaks the chain (trigger rejects it).
    const brokenAudit: AppendAuditEvent = async (tx, input) => {
      await appendAuditEvent(tx, input);
      await tx.query(
        `insert into public.audit_events (election_id, seq, prev_hash, hash, payload)
         values ($1, 99, repeat('0', 64), repeat('0', 64), '{}')`,
        [input.electionId],
      );
      return { electionId: input.electionId, seq: 99, hash: "" };
    };

    await expect(
      executeCommand(
        assignRole,
        { userId: target.userId, role: "returning_officer", electionId },
        deps(superAdmin, { appendAudit: brokenAudit }),
      ),
    ).rejects.toThrow("audit chain violation");

    const rows = await app.query(
      "select 1 from public.staff_roles where user_id = $1 and election_id = $2",
      [target.userId, electionId],
    );
    expect(rows.rowCount).toBe(0);
    expect(await auditEvents(app, { electionId })).toHaveLength(0);
  });

  it("runs rollback hooks to compensate external side effects", async () => {
    const authAdmin = fakeAuthAdmin();
    const { createStaff } = createStaffCommands(authAdmin);
    const email = `${randomUUID()}@fixture.test`;

    await expect(
      executeCommand(
        createStaff,
        { email, displayName: "New", password: "Correct-Horse-9" },
        deps(superAdmin, {
          appendAudit: async () => {
            throw new Error("injected audit failure");
          },
        }),
      ),
    ).rejects.toThrow("injected audit failure");

    expect(authAdmin.deleted).toHaveLength(1);
    const staff = await app.query("select 1 from public.staff where email = $1", [email]);
    expect(staff.rowCount).toBe(0);
  });

  it("rejects invalid input before authorizing", async () => {
    const { assignRole } = createStaffCommands(fakeAuthAdmin());
    await expectCommandError(
      executeCommand(assignRole, { userId: "not-a-uuid", role: "observer" }, deps(superAdmin)),
      "invalid_input",
    );
  });
});

describe("Super Admin only: staff management", () => {
  it.each(["createStaff", "deactivateStaff", "assignRole", "revokeRole"] as const)(
    "rejects a Returning Officer calling %s and audits the attempt",
    async (name) => {
      const electionId = randomUUID();
      const ro = actorFor(
        await createStaffFixture(admin, [{ role: "returning_officer", electionId }]),
      );
      const victim = await createStaffFixture(admin, [{ role: "observer", electionId }]);
      const authAdmin = fakeAuthAdmin();
      const commands = createStaffCommands(authAdmin);
      const attempts = {
        createStaff: () =>
          executeCommand(
            commands.createStaff,
            {
              email: `${randomUUID()}@fixture.test`,
              displayName: "X",
              password: "Correct-Horse-9",
            },
            deps(ro),
          ),
        deactivateStaff: () =>
          executeCommand(commands.deactivateStaff, { userId: victim.userId }, deps(ro)),
        assignRole: () =>
          executeCommand(
            commands.assignRole,
            { userId: victim.userId, role: "presiding_officer", electionId, boothId: randomUUID() },
            deps(ro),
          ),
        revokeRole: () =>
          executeCommand(commands.revokeRole, { assignmentId: victim.roles[0]!.id }, deps(ro)),
      };

      await expectCommandError(attempts[name](), "forbidden");

      const denied = await auditEvents(app, {
        electionId: null,
        eventType: "authz.denied",
        actorId: ro.userId,
      });
      expect(denied).toHaveLength(1);
      expect(denied[0]!.payload.detail).toMatchObject({ action: commands[name].name });

      // Nothing changed.
      expect(authAdmin.deleted).toHaveLength(0);
      const victimState = await app.query<{ active: boolean; roles: number }>(
        `select s.active, (select count(*)::int from public.staff_roles r
                            where r.user_id = s.user_id and r.revoked_at is null) as roles
           from public.staff s where s.user_id = $1`,
        [victim.userId],
      );
      expect(victimState.rows[0]).toEqual({ active: true, roles: 1 });
    },
  );

  it("lets a Super Admin create, assign, revoke and deactivate", async () => {
    const sa = actorFor(await createStaffFixture(admin, [{ role: "super_admin" }]));
    const authAdmin = fakeAuthAdmin();
    const { createStaff, assignRole, revokeRole, deactivateStaff } = createStaffCommands(authAdmin);
    const electionId = randomUUID();
    const boothId = randomUUID();
    await ensureBooth(admin, electionId, boothId);

    const { userId } = await executeCommand(
      createStaff,
      {
        email: `${randomUUID()}@Fixture.test`,
        displayName: "Officer",
        password: "Correct-Horse-9",
      },
      deps(sa),
    );
    const { assignmentId } = await executeCommand(
      assignRole,
      { userId, role: "presiding_officer", electionId, boothId },
      deps(sa),
    );
    await executeCommand(revokeRole, { assignmentId }, deps(sa));
    await executeCommand(deactivateStaff, { userId }, deps(sa));

    expect(authAdmin.banned).toEqual([userId]);
    const created = await auditEvents(app, { electionId: null, targetId: userId });
    expect(created.map((e) => e.payload.event_type)).toEqual([
      "staff.created",
      "staff.deactivated",
    ]);
    expect(JSON.stringify(created)).not.toContain("Correct-Horse-9");
    const scoped = await auditEvents(app, { electionId, targetId: assignmentId });
    expect(scoped.map((e) => e.payload.event_type)).toEqual([
      "staff.role_assigned",
      "staff.role_revoked",
    ]);
  });

  it("rejects a role assignment that breaks the scope rules", async () => {
    const sa = actorFor(await createStaffFixture(admin, [{ role: "super_admin" }]));
    const victim = await createStaffFixture(admin, []);
    const { assignRole } = createStaffCommands(fakeAuthAdmin());
    await expectCommandError(
      executeCommand(
        assignRole,
        { userId: victim.userId, role: "presiding_officer", electionId: randomUUID() },
        deps(sa),
      ),
      "invalid_input",
    );
  });
});

describe("scope authorization", () => {
  const boothAction = defineCommand({
    name: "test.booth_action",
    input: z.object({ boothId: z.uuid() }),
    authorize: (actor, input) => boothGrant(actor, input.boothId),
    describeTarget: (input) => ({
      electionId: null,
      target: { type: "polling_booth", id: input.boothId },
    }),
    async execute(ctx, input) {
      return {
        result: "done",
        audit: {
          electionId: ctx.grant.electionId,
          target: { type: "polling_booth", id: input.boothId },
          before: null,
          after: null,
        },
      };
    },
  });

  it("allows a Presiding Officer to act on their own booth", async () => {
    const electionId = randomUUID();
    const boothId = randomUUID();
    const po = actorFor(
      await createStaffFixture(admin, [{ role: "presiding_officer", electionId, boothId }]),
    );
    await expect(executeCommand(boothAction, { boothId }, deps(po))).resolves.toBe("done");
  });

  it("rejects a Presiding Officer acting on another booth and records an Audit Event", async () => {
    const electionId = randomUUID();
    const ownBooth = randomUUID();
    const otherBooth = randomUUID();
    const po = actorFor(
      await createStaffFixture(admin, [
        { role: "presiding_officer", electionId, boothId: ownBooth },
      ]),
    );

    await expectCommandError(
      executeCommand(boothAction, { boothId: otherBooth }, deps(po)),
      "forbidden",
    );

    const denied = await auditEvents(app, {
      electionId: null,
      eventType: "authz.denied",
      actorId: po.userId,
    });
    expect(denied).toHaveLength(1);
    expect(denied[0]!.payload).toMatchObject({
      event_type: "authz.denied",
      actor: { user_id: po.userId },
      target: { type: "polling_booth", id: otherBooth },
      detail: {
        action: "test.booth_action",
        actor_roles: [{ role: "presiding_officer", election_id: electionId, booth_id: ownBooth }],
      },
    });
  });
});

describe("re-authentication for critical actions", () => {
  const closePoll = defineCommand({
    name: "test.poll_closed",
    critical: true,
    input: z.object({ boothId: z.uuid() }),
    authorize: (actor, input) => boothGrant(actor, input.boothId),
    describeTarget: (input) => ({
      electionId: null,
      target: { type: "polling_booth", id: input.boothId },
    }),
    async execute(ctx, input) {
      return {
        result: "closed",
        audit: {
          electionId: ctx.grant.electionId,
          target: { type: "polling_booth", id: input.boothId },
          before: null,
          after: null,
        },
      };
    },
  });

  it("rejects a request whose last password entry is older than 5 minutes", async () => {
    const electionId = randomUUID();
    const boothId = randomUUID();
    const staff = await createStaffFixture(admin, [
      { role: "presiding_officer", electionId, boothId },
    ]);
    const sixMinutesAgo = Math.floor(Date.now() / 1000) - 6 * 60;
    const po = actorFor(staff, { aal: "aal1", authTimes: { password: sixMinutesAgo, totp: null } });
    const execute = vi.spyOn(closePoll, "execute");

    await expectCommandError(executeCommand(closePoll, { boothId }, deps(po)), "reauth_required");
    expect(execute).not.toHaveBeenCalled();
    expect(await auditEvents(app, { electionId })).toHaveLength(0);
  });

  it("accepts the same request after a fresh password entry", async () => {
    const electionId = randomUUID();
    const boothId = randomUUID();
    const staff = await createStaffFixture(admin, [
      { role: "presiding_officer", electionId, boothId },
    ]);
    const po = actorFor(staff, {
      aal: "aal1",
      authTimes: { password: Math.floor(Date.now() / 1000) - 60, totp: null },
    });
    await expect(executeCommand(closePoll, { boothId }, deps(po))).resolves.toBe("closed");
  });
});
