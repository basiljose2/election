import { createHash, randomInt } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AppendAuditEvent } from "@/lib/audit/append";
import type { AuditActor } from "@/lib/audit/chain";
import { withTransaction } from "@/lib/db/pool";
import { signalAfterCommit } from "@/lib/signals/publish";
import type { SignalPublisher } from "@/lib/signals/types";
import { constantTimeEqual, issueTerminal, revokeActiveTerminal } from "./credentials";

/**
 * Pairing of a Voting Terminal: a one-time code is generated on the Master Terminal, a kiosk
 * submits it, the Presiding Officer confirms the kiosk's short device id, and the kiosk then
 * collects its credential exactly once.
 *
 *   active ──kiosk submits──▶ pending ──PO confirms──▶ confirmed ──kiosk collects──▶ completed
 *      │                         │ └──PO rejects──▶ rejected
 *      └─ expired / invalidated (too many wrong guesses, newer code, timeout)
 */

export const PAIRING_CODE_TTL_MS = 2 * 60 * 1000;
export const PAIRING_CONFIRM_TTL_MS = 2 * 60 * 1000;
export const PAIRING_CODE_MAX_ATTEMPTS = 5;
export const PAIRING_IP_MAX_FAILURES = 5;
export const PAIRING_IP_WINDOW_MS = 15 * 60 * 1000;
/** System-wide ceiling on wrong codes, against distributed guessing. */
export const PAIRING_GLOBAL_MAX_FAILURES_PER_MINUTE = 30;

export interface PairingDeps {
  db: Pool;
  now(): Date;
  appendAudit: AppendAuditEvent;
  publisher: SignalPublisher;
}

export const codeHash = (codeId: string, code: string): string =>
  createHash("sha256").update(`${codeId}:${code}`, "utf8").digest("hex");

export const hashIp = (ip: string): string =>
  createHash("sha256").update(`campus-evm/pairing-ip:${ip}`, "utf8").digest("hex");

export const hashNonce = (nonce: string): string =>
  createHash("sha256").update(nonce, "utf8").digest("hex");

/** 4-character identifier both the kiosk and the Presiding Officer see. */
export const deviceIdFor = (nonce: string): string => hashNonce(nonce).slice(0, 4).toUpperCase();

export const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

export const DEVICE_ACTOR = (terminalId: string | null = null): AuditActor => ({
  user_id: null,
  role: "voting_terminal",
  terminal_id: terminalId,
});

type Hooks = Array<() => Promise<void>>;

/** Runs `fn` in a transaction and then the after-commit hooks (signals). */
async function inTransaction<T>(
  deps: PairingDeps,
  fn: (tx: PoolClient, onCommit: (h: () => Promise<void>) => void) => Promise<T>,
): Promise<T> {
  const hooks: Hooks = [];
  const result = await withTransaction(deps.db, (tx) => fn(tx, (h) => hooks.push(h)));
  for (const hook of hooks) await hook().catch((e) => console.error("[pairing] publish failed", e));
  return result;
}

export type SubmitResult =
  | { status: "pending"; deviceId: string }
  | { status: "invalid" }
  | { status: "rate_limited" }
  | { status: "unavailable" };

/**
 * A kiosk submits the code it was shown. Wrong, unknown and expired codes are
 * indistinguishable to the caller. Per client address: more than 5 wrong codes in 15 minutes
 * blocks further attempts (each blocked attempt is audited). With a booth hint (from the QR
 * code), 5 wrong codes also invalidate that booth's live code.
 */
export async function submitPairingCode(
  deps: PairingDeps,
  input: { code: string; ip: string; nonce: string; boothHint?: string | null },
): Promise<SubmitResult> {
  const now = deps.now();
  const ipHash = hashIp(input.ip);

  return inTransaction(deps, async (tx, onCommit) => {
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `pairing-ip:${ipHash}`,
    ]);

    const recent = await tx.query<{ ip: string; global: string }>(
      `select count(*) filter (where ip_hash = $1) as ip, count(*) as global
         from public.pairing_attempts
        where not succeeded and attempted_at > $2::timestamptz - make_interval(secs => $3)`,
      [ipHash, now, PAIRING_IP_WINDOW_MS / 1000],
    );
    const ipFailures = Number(recent.rows[0]!.ip);
    if (ipFailures >= PAIRING_IP_MAX_FAILURES) {
      await deps.appendAudit(tx, {
        electionId: null,
        eventType: "pairing.rate_limited",
        actor: DEVICE_ACTOR(),
        target: { type: "client", id: ipHash.slice(0, 16) },
        detail: { failures_in_window: ipFailures },
      });
      return { status: "rate_limited" } as const;
    }
    const globalRecent = await tx.query<{ n: string }>(
      `select count(*) as n from public.pairing_attempts
        where not succeeded and attempted_at > $1::timestamptz - interval '1 minute'`,
      [now],
    );
    if (Number(globalRecent.rows[0]!.n) >= PAIRING_GLOBAL_MAX_FAILURES_PER_MINUTE) {
      return { status: "rate_limited" } as const;
    }

    // Retire codes that ran out of time, then look for the submitted value among live ones.
    await tx.query(
      "update public.pairing_codes set status = 'expired' where status = 'active' and expires_at <= $1",
      [now],
    );
    const live = await tx.query<{
      id: string;
      election_id: string;
      booth_id: string;
      code_hash: string;
    }>(
      "select id, election_id, booth_id, code_hash from public.pairing_codes where status = 'active' for update",
    );
    const match = live.rows.find((row) =>
      constantTimeEqual(row.code_hash, codeHash(row.id, input.code)),
    );

    if (!match) {
      await tx.query(
        "insert into public.pairing_attempts (ip_hash, succeeded, attempted_at) values ($1, false, $2)",
        [ipHash, now],
      );
      if (input.boothHint) {
        const hinted = live.rows.find((row) => row.booth_id === input.boothHint);
        if (hinted) {
          const bumped = await tx.query<{ attempts: number }>(
            "update public.pairing_codes set attempts = attempts + 1 where id = $1 returning attempts",
            [hinted.id],
          );
          if (bumped.rows[0]!.attempts >= PAIRING_CODE_MAX_ATTEMPTS) {
            await tx.query("update public.pairing_codes set status = 'invalidated' where id = $1", [
              hinted.id,
            ]);
            await deps.appendAudit(tx, {
              electionId: hinted.election_id,
              eventType: "pairing.code_invalidated",
              actor: DEVICE_ACTOR(),
              target: { type: "booth", id: hinted.booth_id },
              detail: { reason: "too_many_wrong_codes" },
            });
          }
        }
      }
      return { status: "invalid" } as const;
    }

    const available = await tx.query<{ accepts: boolean; pending: boolean }>(
      `select public.booth_accepts_terminals($1) as accepts,
              public.booth_has_pending_ballot_session($1) as pending`,
      [match.booth_id],
    );
    if (!available.rows[0]!.accepts || available.rows[0]!.pending) {
      await tx.query(
        "insert into public.pairing_attempts (ip_hash, succeeded, attempted_at) values ($1, false, $2)",
        [ipHash, now],
      );
      return { status: "unavailable" } as const;
    }

    const deviceId = deviceIdFor(input.nonce);
    await tx.query(
      `update public.pairing_codes
          set status = 'pending', device_nonce_hash = $2, device_id = $3, pending_expires_at = $4
        where id = $1`,
      [
        match.id,
        hashNonce(input.nonce),
        deviceId,
        new Date(now.getTime() + PAIRING_CONFIRM_TTL_MS),
      ],
    );
    await tx.query(
      "insert into public.pairing_attempts (ip_hash, succeeded, attempted_at) values ($1, true, $2)",
      [ipHash, now],
    );
    await deps.appendAudit(tx, {
      electionId: match.election_id,
      eventType: "pairing.requested",
      actor: DEVICE_ACTOR(),
      target: { type: "booth", id: match.booth_id },
      detail: { device_id: deviceId },
    });
    await signalAfterCommit({ tx, onCommit }, deps.publisher, match.booth_id, "pairing-changed");
    return { status: "pending", deviceId } as const;
  });
}

export type CollectResult =
  | { status: "unknown" }
  | { status: "waiting"; deviceId: string }
  | { status: "rejected" }
  | { status: "expired" }
  | { status: "unavailable" }
  | { status: "completed" }
  | { status: "paired"; token: string; terminalId: string; boothId: string };

/**
 * The kiosk asks what became of its pairing request. Once the Presiding Officer has
 * confirmed, the first call issues the credential (returned exactly once), revokes the
 * booth's previous Voting Terminal and records both in the audit log.
 */
export async function collectPairing(
  deps: PairingDeps,
  input: { nonce: string },
): Promise<CollectResult> {
  const now = deps.now();
  return inTransaction(deps, async (tx, onCommit) => {
    const found = await tx.query<{
      id: string;
      election_id: string;
      booth_id: string;
      status: string;
      device_id: string;
      pending_expires_at: Date | null;
      created_by: string;
    }>(
      `select id, election_id, booth_id, status, device_id, pending_expires_at, created_by
         from public.pairing_codes where device_nonce_hash = $1 for update`,
      [hashNonce(input.nonce)],
    );
    const code = found.rows[0];
    if (!code) return { status: "unknown" } as const;

    switch (code.status) {
      case "rejected":
        return { status: "rejected" } as const;
      case "expired":
      case "invalidated":
        return { status: "expired" } as const;
      case "completed":
        return { status: "completed" } as const;
      case "pending":
        if (!code.pending_expires_at || code.pending_expires_at <= now) {
          await tx.query("update public.pairing_codes set status = 'expired' where id = $1", [
            code.id,
          ]);
          return { status: "expired" } as const;
        }
        return { status: "waiting", deviceId: code.device_id } as const;
      case "confirmed":
        break;
      default:
        return { status: "unknown" } as const;
    }

    if (!code.pending_expires_at || code.pending_expires_at <= now) {
      await tx.query("update public.pairing_codes set status = 'expired' where id = $1", [code.id]);
      return { status: "expired" } as const;
    }
    const gate = await tx.query<{ accepts: boolean; pending: boolean }>(
      `select public.booth_accepts_terminals($1) as accepts,
              public.booth_has_pending_ballot_session($1) as pending`,
      [code.booth_id],
    );
    if (!gate.rows[0]!.accepts || gate.rows[0]!.pending) return { status: "unavailable" } as const;

    const previous = await revokeActiveTerminal(tx, code.booth_id, "voting", "replaced");
    const { terminalId, token } = await issueTerminal(tx, {
      electionId: code.election_id,
      boothId: code.booth_id,
      type: "voting",
      deviceId: code.device_id,
      registeredBy: code.created_by,
    });
    await tx.query(
      "update public.pairing_codes set status = 'completed', terminal_id = $2 where id = $1",
      [code.id, terminalId],
    );
    if (previous) {
      await deps.appendAudit(tx, {
        electionId: code.election_id,
        eventType: "terminal.revoked",
        actor: DEVICE_ACTOR(),
        target: { type: "terminal", id: previous },
        before: { status: "active" },
        after: { status: "revoked", reason: "replaced" },
        detail: { booth_id: code.booth_id, type: "voting" },
      });
    }
    await deps.appendAudit(tx, {
      electionId: code.election_id,
      eventType: "terminal.paired",
      actor: DEVICE_ACTOR(terminalId),
      target: { type: "terminal", id: terminalId },
      before: null,
      after: { booth_id: code.booth_id, type: "voting", device_id: code.device_id },
      detail: { replaced_terminal_id: previous, confirmed_by: code.created_by },
    });
    if (previous) {
      await signalAfterCommit({ tx, onCommit }, deps.publisher, code.booth_id, "terminal-revoked");
    }
    await signalAfterCommit({ tx, onCommit }, deps.publisher, code.booth_id, "pairing-changed");
    return { status: "paired", token, terminalId, boothId: code.booth_id } as const;
  });
}
