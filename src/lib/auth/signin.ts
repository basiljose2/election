import type { Pool, PoolClient } from "pg";
import type { AppendAuditEvent } from "@/lib/audit/append";
import { withTransaction } from "@/lib/db/pool";

export const SIGNIN_MAX_FAILURES = 5;
export const SIGNIN_WINDOW_MS = 15 * 60 * 1000;
export const SIGNIN_LOCKOUT_MS = 15 * 60 * 1000;

export type PasswordCheck = { ok: true; userId: string; sessionId: string } | { ok: false };

export interface Authenticator {
  /** Verifies the password with Supabase Auth and, on success, sets the session cookies. */
  signInWithPassword(email: string, password: string): Promise<PasswordCheck>;
  /** Clears the session just created (used when the account may not sign in). */
  signOut(): Promise<void>;
}

export interface SignInDeps {
  db: Pool;
  now(): Date;
  authenticator: Authenticator;
  appendAudit: AppendAuditEvent;
}

export type SignInResult =
  | { status: "ok"; userId: string; sessionId: string }
  | { status: "invalid" }
  | { status: "locked" };

export function normaliseAccountKey(email: string): string {
  return email.trim().toLowerCase();
}

const ACCOUNT_TARGET = (accountKey: string) => ({ type: "account", id: accountKey });

/**
 * Password sign-in with per-account rate limiting: more than 5 failed attempts within
 * 15 minutes locks the account's sign-in for 15 minutes. Blocked attempts are audited.
 * In-flight attempts count as failures so parallel guesses cannot exceed the limit.
 */
export async function signInWithPassword(
  email: string,
  password: string,
  deps: SignInDeps,
  options: { previousSessionId?: string } = {},
): Promise<SignInResult> {
  const accountKey = normaliseAccountKey(email);
  if (!accountKey || !password) return { status: "invalid" };

  const admitted = await withTransaction(deps.db, async (tx) => {
    const now = deps.now();
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `campus-evm/signin/${accountKey}`,
    ]);

    const lockout = await tx.query<{ locked_until: Date }>(
      `select locked_until from public.signin_lockouts
        where account_key = $1 and locked_until > $2
        order by locked_until desc limit 1`,
      [accountKey, now],
    );
    if (lockout.rows[0]) {
      await deps.appendAudit(tx, {
        electionId: null,
        eventType: "auth.signin_blocked",
        actor: { user_id: null, role: null, terminal_id: null },
        target: ACCOUNT_TARGET(accountKey),
        detail: { locked_until: lockout.rows[0].locked_until.toISOString() },
      });
      return null;
    }

    const recent = await tx.query<{ n: number }>(
      `select count(*)::int as n from public.signin_attempts
        where account_key = $1 and attempted_at > $2 and outcome is distinct from 'success'`,
      [accountKey, new Date(now.getTime() - SIGNIN_WINDOW_MS)],
    );
    if ((recent.rows[0]?.n ?? 0) >= SIGNIN_MAX_FAILURES) {
      await lockAccount(tx, deps, accountKey, now);
      await deps.appendAudit(tx, {
        electionId: null,
        eventType: "auth.signin_blocked",
        actor: { user_id: null, role: null, terminal_id: null },
        target: ACCOUNT_TARGET(accountKey),
        detail: { reason: "too_many_attempts" },
      });
      return null;
    }

    const attempt = await tx.query<{ id: string }>(
      `insert into public.signin_attempts (account_key, attempted_at) values ($1, $2) returning id`,
      [accountKey, now],
    );
    return attempt.rows[0]!.id;
  });

  if (admitted === null) return { status: "locked" };

  const check = await deps.authenticator.signInWithPassword(accountKey, password);

  let result: SignInResult = { status: "invalid" };
  let signOut = !check.ok;

  await withTransaction(deps.db, async (tx) => {
    const now = deps.now();
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `campus-evm/signin/${accountKey}`,
    ]);

    if (!check.ok) {
      await recordFailure(tx, deps, accountKey, admitted, now, "invalid_credentials", null);
      return;
    }

    const staff = await tx.query<{ active: boolean }>(
      "select active from public.staff where user_id = $1",
      [check.userId],
    );
    if (!staff.rows[0]?.active) {
      signOut = true;
      await recordFailure(
        tx,
        deps,
        accountKey,
        admitted,
        now,
        staff.rows[0] ? "account_deactivated" : "not_staff",
        check.userId,
      );
      return;
    }

    await tx.query("update public.signin_attempts set outcome = 'success' where id = $1", [
      admitted,
    ]);
    if (options.previousSessionId) {
      await tx.query(
        `update public.staff_sessions set ended_at = $3, end_reason = 'signed_out'
          where session_id = $1 and user_id = $2 and ended_at is null`,
        [options.previousSessionId, check.userId, now],
      );
    }
    await tx.query(
      `insert into public.staff_sessions (session_id, user_id, kind, created_at, last_seen_at)
       values ($1, $2, 'staff', $3, $3)`,
      [check.sessionId, check.userId, now],
    );
    await deps.appendAudit(tx, {
      electionId: null,
      eventType: "auth.signed_in",
      actor: { user_id: check.userId, role: null, terminal_id: null },
      target: { type: "staff_session", id: check.sessionId },
      detail: { reauthentication: Boolean(options.previousSessionId) },
    });
    result = { status: "ok", userId: check.userId, sessionId: check.sessionId };
  });

  if (signOut && check.ok) await deps.authenticator.signOut();
  return result;
}

async function lockAccount(tx: PoolClient, deps: SignInDeps, accountKey: string, now: Date) {
  const lockedUntil = new Date(now.getTime() + SIGNIN_LOCKOUT_MS);
  await tx.query(
    `insert into public.signin_lockouts (account_key, locked_at, locked_until) values ($1, $2, $3)`,
    [accountKey, now, lockedUntil],
  );
  await deps.appendAudit(tx, {
    electionId: null,
    eventType: "auth.account_locked",
    actor: { user_id: null, role: null, terminal_id: null },
    target: ACCOUNT_TARGET(accountKey),
    detail: { locked_until: lockedUntil.toISOString(), max_failures: SIGNIN_MAX_FAILURES },
  });
}

async function recordFailure(
  tx: PoolClient,
  deps: SignInDeps,
  accountKey: string,
  attemptId: string,
  now: Date,
  reason: string,
  userId: string | null,
) {
  await tx.query("update public.signin_attempts set outcome = 'failure' where id = $1", [
    attemptId,
  ]);
  await deps.appendAudit(tx, {
    electionId: null,
    eventType: "auth.signin_failed",
    actor: { user_id: userId, role: null, terminal_id: null },
    target: ACCOUNT_TARGET(accountKey),
    detail: { reason },
  });
  const failures = await tx.query<{ n: number }>(
    `select count(*)::int as n from public.signin_attempts
      where account_key = $1 and attempted_at > $2 and outcome = 'failure'`,
    [accountKey, new Date(now.getTime() - SIGNIN_WINDOW_MS)],
  );
  if ((failures.rows[0]?.n ?? 0) >= SIGNIN_MAX_FAILURES) {
    await lockAccount(tx, deps, accountKey, now);
  }
}
