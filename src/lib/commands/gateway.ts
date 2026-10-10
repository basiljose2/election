import "server-only";
import type { Pool } from "pg";
import type { z } from "zod";
import { appendAuditEvent, type AppendAuditEvent } from "@/lib/audit/append";
import type { JsonValue } from "@/lib/audit/canonical-json";
import type { AuditTarget } from "@/lib/audit/chain";
import type { Actor, RoleAssignment } from "@/lib/auth/roles";
import { hasRecentAuth } from "@/lib/auth/session-policy";
import { withTransaction, type Tx } from "@/lib/db/pool";
import { CommandError } from "./errors";

/**
 * The single mutation path of the application ("commands").
 *
 *   authenticate → authorize (role + scope) → [re-auth for critical actions]
 *   → one DB transaction { validate lifecycle → execute → append Audit Event } → commit
 *
 * If the Audit Event cannot be written the whole transaction rolls back and the caller
 * gets an error. Denied authorization attempts are audited in their own transaction.
 */

export interface CommandContext {
  tx: Tx;
  actor: Actor;
  /** The role assignment that authorized this command. */
  grant: RoleAssignment;
  /** The gateway's clock (injectable in tests). */
  now(): Date;
  /** Runs after the transaction commits (e.g. calls to external services). */
  onCommit(fn: () => Promise<void>): void;
  /** Runs if the transaction rolls back (compensate external side effects). */
  onRollback(fn: () => Promise<void>): void;
}

export interface CommandAudit {
  electionId: string | null;
  target: AuditTarget;
  before: JsonValue;
  after: JsonValue;
  detail?: JsonValue;
}

export interface CommandOutcome<O> {
  result: O;
  audit: CommandAudit;
}

export interface CommandDefinition<S extends z.ZodType, O> {
  /** Also the Audit Event type, e.g. "staff.role_assigned". */
  name: string;
  input: S;
  /** Critical actions require re-authentication within the last 5 minutes. */
  critical?: boolean;
  /** Returns the assignment that permits `actor` to run this command, or null. */
  authorize(actor: Actor, input: z.output<S>): RoleAssignment | null;
  /** What a denied attempt was aimed at (recorded in the denial Audit Event). */
  describeTarget(input: z.output<S>): { electionId: string | null; target: AuditTarget };
  /** Lifecycle validation inside the transaction, before any write. Throw CommandError. */
  validate?(ctx: CommandContext, input: z.output<S>): Promise<void>;
  execute(ctx: CommandContext, input: z.output<S>): Promise<CommandOutcome<O>>;
}

export function defineCommand<S extends z.ZodType, O>(
  definition: CommandDefinition<S, O>,
): CommandDefinition<S, O> {
  return definition;
}

export interface GatewayDeps {
  db: Pool;
  now(): Date;
  /** Resolves the authenticated actor or throws CommandError("unauthenticated" | "mfa_required"). */
  authenticate(): Promise<Actor>;
  appendAudit: AppendAuditEvent;
}

async function defaultDeps(): Promise<GatewayDeps> {
  const [{ getPool }, { requireActorForCommand }] = await Promise.all([
    import("@/lib/db/pool"),
    import("@/lib/auth/current-actor"),
  ]);
  return {
    db: getPool(),
    now: () => new Date(),
    authenticate: requireActorForCommand,
    appendAudit: appendAuditEvent,
  };
}

export async function executeCommand<S extends z.ZodType, O>(
  command: CommandDefinition<S, O>,
  rawInput: unknown,
  overrides: Partial<GatewayDeps> = {},
): Promise<O> {
  const deps: GatewayDeps = { ...(await defaultDeps()), ...overrides };

  // 1. Authenticate.
  const actor = await deps.authenticate();

  // 2. Parse input (shape only; lifecycle rules are validated inside the transaction).
  const parsed = command.input.safeParse(rawInput);
  if (!parsed.success) {
    throw new CommandError("invalid_input", parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const input = parsed.data;

  // 3. Authorize by role and scope. Denials are audited.
  const grant = command.authorize(actor, input);
  if (!grant) {
    await recordDeniedAttempt(deps, actor, command.name, command.describeTarget(input));
    throw new CommandError("forbidden", "You are not authorized to perform this action");
  }

  // 4. Critical actions need a fresh password (+ TOTP for privileged roles).
  if (command.critical && !hasRecentAuth(actor, deps.now())) {
    throw new CommandError("reauth_required", "Re-authenticate to perform this action");
  }

  // 5. One transaction: validate → execute → audit → commit.
  const commitHooks: Array<() => Promise<void>> = [];
  const rollbackHooks: Array<() => Promise<void>> = [];

  let result: O;
  try {
    result = await withTransaction(deps.db, async (tx) => {
      const ctx: CommandContext = {
        tx,
        actor,
        grant,
        now: deps.now,
        onCommit: (fn) => commitHooks.push(fn),
        onRollback: (fn) => rollbackHooks.push(fn),
      };
      await command.validate?.(ctx, input);
      const outcome = await command.execute(ctx, input);
      await deps.appendAudit(tx, {
        electionId: outcome.audit.electionId,
        eventType: command.name,
        actor: { user_id: actor.userId, role: grant.role, terminal_id: null },
        target: outcome.audit.target,
        before: outcome.audit.before,
        after: outcome.audit.after,
        detail: outcome.audit.detail ?? null,
      });
      return outcome.result;
    });
  } catch (error) {
    for (const fn of rollbackHooks.reverse()) {
      await fn().catch((e) => console.error(`[${command.name}] rollback hook failed`, e));
    }
    throw error;
  }

  for (const fn of commitHooks) {
    await fn().catch((e) => console.error(`[${command.name}] commit hook failed`, e));
  }
  return result;
}

/**
 * Records a denied authorization attempt. Denials go to the system chain: the target
 * scope comes from untrusted input, so it is recorded in the payload rather than used to
 * choose a chain.
 */
export async function recordDeniedAttempt(
  deps: Pick<GatewayDeps, "db" | "appendAudit">,
  actor: Actor,
  action: string,
  attempted: { electionId: string | null; target: AuditTarget },
): Promise<void> {
  try {
    await withTransaction(deps.db, (tx) =>
      deps.appendAudit(tx, {
        electionId: null,
        eventType: "authz.denied",
        actor: { user_id: actor.userId, role: null, terminal_id: null },
        target: attempted.target,
        detail: {
          action,
          election_id: attempted.electionId,
          actor_roles: actor.roles.map((r) => ({
            role: r.role,
            election_id: r.electionId,
            booth_id: r.boothId,
          })),
        },
      }),
    );
  } catch (error) {
    // The request is denied either way; never let a logging failure turn into access.
    console.error(`[${action}] failed to audit denied attempt`, error);
  }
}
