import { z } from "zod";
import { STAFF_ROLES, superAdminGrant } from "@/lib/auth/roles";
import { defineCommand } from "./gateway";
import { CommandError } from "./errors";

/** Supabase Auth admin operations used by staff management (injected for tests). */
export interface AuthAdmin {
  createUser(email: string, password: string): Promise<{ userId: string }>;
  deleteUser(userId: string): Promise<void>;
  banUser(userId: string): Promise<void>;
}

const uuid = z.uuid();

function pgCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function createStaffCommands(authAdmin: AuthAdmin) {
  const createStaff = defineCommand({
    name: "staff.created",
    input: z.object({
      email: z.email().transform((e) => e.trim().toLowerCase()),
      displayName: z.string().trim().min(1).max(200),
      password: z.string().min(12, "Password must be at least 12 characters").max(128),
    }),
    authorize: (actor) => superAdminGrant(actor),
    describeTarget: (input) => ({ electionId: null, target: { type: "staff", id: input.email } }),
    async validate({ tx }, input) {
      const existing = await tx.query("select 1 from public.staff where email = $1", [input.email]);
      if (existing.rowCount)
        throw new CommandError("conflict", "A staff account with this email exists");
    },
    async execute({ tx, onRollback }, input) {
      const { userId } = await authAdmin.createUser(input.email, input.password);
      onRollback(() => authAdmin.deleteUser(userId));
      await tx.query(
        "insert into public.staff (user_id, email, display_name) values ($1, $2, $3)",
        [userId, input.email, input.displayName],
      );
      return {
        result: { userId },
        audit: {
          electionId: null,
          target: { type: "staff", id: userId },
          before: null,
          after: { email: input.email, display_name: input.displayName, active: true },
        },
      };
    },
  });

  const deactivateStaff = defineCommand({
    name: "staff.deactivated",
    input: z.object({ userId: uuid }),
    authorize: (actor) => superAdminGrant(actor),
    describeTarget: (input) => ({ electionId: null, target: { type: "staff", id: input.userId } }),
    async validate({ tx, actor }, input) {
      if (input.userId === actor.userId) {
        throw new CommandError("lifecycle", "You cannot deactivate your own account");
      }
      const staff = await tx.query<{ active: boolean }>(
        "select active from public.staff where user_id = $1 for update",
        [input.userId],
      );
      if (!staff.rows[0]) throw new CommandError("not_found", "Staff account not found");
      if (!staff.rows[0].active)
        throw new CommandError("lifecycle", "Account is already deactivated");
    },
    async execute({ tx, onCommit }, input) {
      await tx.query(
        "update public.staff set active = false, deactivated_at = now() where user_id = $1",
        [input.userId],
      );
      const ended = await tx.query(
        `update public.staff_sessions set ended_at = now(), end_reason = 'deactivated'
          where user_id = $1 and ended_at is null`,
        [input.userId],
      );
      onCommit(() => authAdmin.banUser(input.userId));
      return {
        result: { userId: input.userId },
        audit: {
          electionId: null,
          target: { type: "staff", id: input.userId },
          before: { active: true },
          after: { active: false },
          detail: { sessions_ended: ended.rowCount ?? 0 },
        },
      };
    },
  });

  const assignRole = defineCommand({
    name: "staff.role_assigned",
    input: z.object({
      userId: uuid,
      role: z.enum(STAFF_ROLES),
      electionId: uuid.nullish().transform((v) => v ?? null),
      boothId: uuid.nullish().transform((v) => v ?? null),
    }),
    authorize: (actor) => superAdminGrant(actor),
    describeTarget: (input) => ({
      electionId: input.electionId,
      target: { type: "staff", id: input.userId },
    }),
    async validate({ tx }, input) {
      const staff = await tx.query<{ active: boolean }>(
        "select active from public.staff where user_id = $1",
        [input.userId],
      );
      if (!staff.rows[0]) throw new CommandError("not_found", "Staff account not found");
      if (!staff.rows[0].active) {
        throw new CommandError("lifecycle", "Cannot assign a role to a deactivated account");
      }
    },
    async execute({ tx, actor }, input) {
      let id: string;
      try {
        const inserted = await tx.query<{ id: string }>(
          `insert into public.staff_roles (user_id, role, election_id, booth_id, assigned_by)
           values ($1, $2, $3, $4, $5) returning id`,
          [input.userId, input.role, input.electionId, input.boothId, actor.userId],
        );
        id = inserted.rows[0]!.id;
      } catch (error) {
        if (pgCode(error) === "23514") {
          throw new CommandError(
            "invalid_input",
            "Returning Officers and Observers need an election; Presiding Officers need an election and a booth; Super Admins need neither",
          );
        }
        if (pgCode(error) === "23505")
          throw new CommandError("conflict", "This role is already assigned");
        throw error;
      }
      return {
        result: { assignmentId: id },
        audit: {
          electionId: input.electionId,
          target: { type: "staff_role", id },
          before: null,
          after: {
            user_id: input.userId,
            role: input.role,
            election_id: input.electionId,
            booth_id: input.boothId,
          },
        },
      };
    },
  });

  const revokeRole = defineCommand({
    name: "staff.role_revoked",
    input: z.object({ assignmentId: uuid }),
    authorize: (actor) => superAdminGrant(actor),
    describeTarget: (input) => ({
      electionId: null,
      target: { type: "staff_role", id: input.assignmentId },
    }),
    async execute({ tx, actor }, input) {
      const found = await tx.query<{
        user_id: string;
        role: string;
        election_id: string | null;
        booth_id: string | null;
        revoked_at: Date | null;
      }>(
        `select user_id, role, election_id, booth_id, revoked_at from public.staff_roles
          where id = $1 for update`,
        [input.assignmentId],
      );
      const row = found.rows[0];
      if (!row) throw new CommandError("not_found", "Role assignment not found");
      if (row.revoked_at) throw new CommandError("lifecycle", "Role assignment is already revoked");
      if (row.user_id === actor.userId && row.role === "super_admin") {
        throw new CommandError("lifecycle", "You cannot revoke your own Super Admin role");
      }
      await tx.query(
        "update public.staff_roles set revoked_at = now(), revoked_by = $2 where id = $1",
        [input.assignmentId, actor.userId],
      );
      const assignment = {
        user_id: row.user_id,
        role: row.role,
        election_id: row.election_id,
        booth_id: row.booth_id,
      };
      return {
        result: { assignmentId: input.assignmentId },
        audit: {
          electionId: row.election_id,
          target: { type: "staff_role", id: input.assignmentId },
          before: { ...assignment, revoked: false },
          after: { ...assignment, revoked: true },
        },
      };
    },
  });

  return { createStaff, deactivateStaff, assignRole, revokeRole };
}

export type StaffCommands = ReturnType<typeof createStaffCommands>;
