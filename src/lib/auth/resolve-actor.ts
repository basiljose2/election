import type { Pool } from "pg";
import type { AppendAuditEvent } from "@/lib/audit/append";
import { CommandError } from "@/lib/commands/errors";
import { withTransaction } from "@/lib/db/pool";
import {
  requiresMfa,
  type Actor,
  type AuthTimes,
  type RoleAssignment,
  type StaffRole,
} from "./roles";
import { idleTimeoutMs, isIdleExpired, type SessionKind } from "./session-policy";

/** Claims from a verified Supabase access token. */
export interface VerifiedClaims {
  sub: string;
  session_id: string;
  aal: string;
  amr?: ReadonlyArray<{ method: string; timestamp: number } | string>;
}

export type ActorResolution =
  | { status: "ok"; actor: Actor }
  | { status: "mfa_required"; actor: Actor }
  | { status: "unauthenticated" }
  | { status: "inactive" }
  | { status: "session_ended" }
  | { status: "idle_timeout" };

export interface ResolveActorDeps {
  db: Pool;
  now(): Date;
  appendAudit: AppendAuditEvent;
}

export function authTimesFromAmr(amr: VerifiedClaims["amr"]): AuthTimes {
  const times: AuthTimes = { password: null, totp: null };
  for (const entry of amr ?? []) {
    if (typeof entry === "string") continue;
    if (entry.method === "password" || entry.method === "totp") {
      times[entry.method] = Math.max(times[entry.method] ?? 0, entry.timestamp);
    }
  }
  return times;
}

export async function loadActiveRoles(
  db: Pick<Pool, "query">,
  userId: string,
): Promise<RoleAssignment[]> {
  const { rows } = await db.query<{
    id: string;
    role: StaffRole;
    election_id: string | null;
    booth_id: string | null;
  }>(
    `select id, role, election_id, booth_id from public.staff_roles
      where user_id = $1 and revoked_at is null order by assigned_at`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    electionId: r.election_id,
    boothId: r.booth_id,
  }));
}

/**
 * Turns a verified token into an Actor. Checks, on every request:
 * - the staff account exists and is active (deactivation invalidates sessions);
 * - the session was started through the app's sign-in and has not ended;
 * - the session has not been idle longer than its timeout (then it is ended);
 * - privileged roles have completed MFA (aal2).
 */
export async function resolveActor(
  claims: VerifiedClaims,
  deps: ResolveActorDeps,
): Promise<ActorResolution> {
  const now = deps.now();

  return withTransaction(deps.db, async (tx) => {
    const staff = await tx.query<{ email: string; display_name: string; active: boolean }>(
      "select email, display_name, active from public.staff where user_id = $1",
      [claims.sub],
    );
    const member = staff.rows[0];
    if (!member) return { status: "unauthenticated" };

    if (!member.active) {
      await tx.query(
        `update public.staff_sessions set ended_at = $2, end_reason = 'deactivated'
          where user_id = $1 and ended_at is null`,
        [claims.sub, now],
      );
      return { status: "inactive" };
    }

    const session = await tx.query<{
      user_id: string;
      kind: SessionKind;
      last_seen_at: Date;
      ended_at: Date | null;
    }>(
      `select user_id, kind, last_seen_at, ended_at from public.staff_sessions
        where session_id = $1 for update`,
      [claims.session_id],
    );
    const current = session.rows[0];
    // Only sessions started by the app's (rate-limited) sign-in are accepted.
    if (!current || current.user_id !== claims.sub) return { status: "unauthenticated" };
    if (current.ended_at) return { status: "session_ended" };

    const roles = await loadActiveRoles(tx, claims.sub);

    if (isIdleExpired(current.last_seen_at, now, idleTimeoutMs(current.kind, roles))) {
      await tx.query(
        `update public.staff_sessions set ended_at = $2, end_reason = 'idle_timeout'
          where session_id = $1`,
        [claims.session_id, now],
      );
      await deps.appendAudit(tx, {
        electionId: null,
        eventType: "auth.session_idle_timeout",
        actor: { user_id: claims.sub, role: null, terminal_id: null },
        target: { type: "staff_session", id: claims.session_id },
        before: { last_seen_at: current.last_seen_at.toISOString() },
        after: { ended: true },
      });
      return { status: "idle_timeout" };
    }

    await tx.query("update public.staff_sessions set last_seen_at = $2 where session_id = $1", [
      claims.session_id,
      now,
    ]);

    const actor: Actor = {
      userId: claims.sub,
      sessionId: claims.session_id,
      email: member.email,
      displayName: member.display_name,
      roles,
      aal: claims.aal === "aal2" ? "aal2" : "aal1",
      authTimes: authTimesFromAmr(claims.amr),
    };

    if (requiresMfa(roles) && actor.aal !== "aal2") return { status: "mfa_required", actor };
    return { status: "ok", actor };
  });
}

/** Commands need a fully authenticated actor (MFA complete where required). */
export function actorForCommand(resolution: ActorResolution): Actor {
  if (resolution.status === "ok") return resolution.actor;
  if (resolution.status === "mfa_required") {
    throw new CommandError("mfa_required", "Complete multi-factor authentication first");
  }
  throw new CommandError("unauthenticated", "Sign in to continue");
}
