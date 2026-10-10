import type { Pool } from "pg";
import type { AppendAuditEvent } from "@/lib/audit/append";
import { withTransaction } from "@/lib/db/pool";
import type { AuthenticatedTerminal } from "./credentials";
import { DEVICE_ACTOR } from "./pairing";

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const OFFLINE_AFTER_MS = 30_000;

/** Records that a paired terminal is alive. Too frequent to audit. */
export async function recordHeartbeat(
  db: Pick<Pool, "query">,
  terminalId: string,
  now: Date,
): Promise<void> {
  await db.query(
    `insert into public.terminal_heartbeats (terminal_id, last_seen_at) values ($1, $2)
     on conflict (terminal_id) do update set last_seen_at = greatest(public.terminal_heartbeats.last_seen_at, excluded.last_seen_at)`,
    [terminalId, now],
  );
}

/** Online/offline is derived from the last heartbeat; it is never stored. */
export function isOnline(lastSeenAt: Date | null, now: Date): boolean {
  return lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() < OFFLINE_AFTER_MS;
}

/** What a Voting Terminal may learn: no counts, no choices, nothing about other terminals. */
export interface VotingTerminalState {
  role: "voting";
  version: number;
  boothState: string;
  ballotPending: boolean;
}

export interface MasterTerminalState {
  role: "master";
  version: number;
  boothState: string;
  ballotPending: boolean;
  /** Ballots cast at this booth (a count only). */
  ballotsCast: number;
  votingTerminal: {
    paired: boolean;
    deviceId: string | null;
    online: boolean;
    lastSeenAt: string | null;
  };
  pairing: {
    codeId: string;
    status: "active" | "pending" | "confirmed";
    expiresAt: string;
    /** Present while a kiosk waits for confirmation. */
    deviceId: string | null;
  } | null;
}

export type TerminalState = VotingTerminalState | MasterTerminalState;

export interface StateDeps {
  db: Pool;
  now(): Date;
  appendAudit: AppendAuditEvent;
}

/**
 * The authoritative state for a terminal. Clients call this on load, on every signal and on
 * reconnect, and treat signals as nothing more than a prompt to ask again.
 */
export async function getTerminalState(
  deps: StateDeps,
  terminal: AuthenticatedTerminal,
): Promise<TerminalState> {
  const now = deps.now();
  const base = await deps.db.query<{
    version: string | null;
    booth_state: string;
    pending: boolean;
  }>(
    `select (select version from public.booth_state_versions where booth_id = $1) as version,
            public.booth_state($1) as booth_state,
            public.booth_has_pending_ballot_session($1) as pending`,
    [terminal.boothId],
  );
  const row = base.rows[0]!;
  const common = {
    version: Number(row.version ?? 0),
    boothState: row.booth_state,
    ballotPending: row.pending,
  };
  if (terminal.type === "voting") return { role: "voting", ...common };

  const voting = await deps.db.query<{
    id: string;
    device_id: string | null;
    last_seen_at: Date | null;
    offline_reported_for: Date | null;
  }>(
    `select t.id, t.device_id, h.last_seen_at, h.offline_reported_for
       from public.terminals t
       left join public.terminal_heartbeats h on h.terminal_id = t.id
      where t.booth_id = $1 and t.type = 'voting' and t.status = 'active'`,
    [terminal.boothId],
  );
  const v = voting.rows[0];
  const online = v ? isOnline(v.last_seen_at, now) : false;

  // The first time the Master Terminal observes a transition to offline, audit it once.
  if (
    v &&
    v.last_seen_at &&
    !online &&
    v.offline_reported_for?.getTime() !== v.last_seen_at.getTime()
  ) {
    await withTransaction(deps.db, async (tx) => {
      const claimed = await tx.query(
        `update public.terminal_heartbeats set offline_reported_for = last_seen_at
          where terminal_id = $1 and offline_reported_for is distinct from last_seen_at`,
        [v.id],
      );
      if (claimed.rowCount) {
        await deps.appendAudit(tx, {
          electionId: terminal.electionId,
          eventType: "terminal.went_offline",
          actor: DEVICE_ACTOR(v.id),
          target: { type: "terminal", id: v.id },
          detail: { booth_id: terminal.boothId, last_seen_at: v.last_seen_at!.toISOString() },
        });
      }
    });
  }

  const code = await deps.db.query<{
    id: string;
    status: "active" | "pending" | "confirmed";
    expires_at: Date;
    pending_expires_at: Date | null;
    device_id: string | null;
  }>(
    `select id, status, expires_at, pending_expires_at, device_id from public.pairing_codes
      where booth_id = $1 and status in ('active', 'pending', 'confirmed')`,
    [terminal.boothId],
  );
  const c = code.rows[0];
  const codeLive = c ? (c.status === "active" ? c.expires_at : c.pending_expires_at)! > now : false;

  const cast = await deps.db.query<{ n: string }>("select public.booth_ballots_cast($1) as n", [
    terminal.boothId,
  ]);

  return {
    role: "master",
    ...common,
    ballotsCast: Number(cast.rows[0]!.n),
    votingTerminal: {
      paired: Boolean(v),
      deviceId: v?.device_id ?? null,
      online,
      lastSeenAt: v?.last_seen_at?.toISOString() ?? null,
    },
    pairing:
      c && codeLive
        ? {
            codeId: c.id,
            status: c.status,
            expiresAt: (c.status === "active" ? c.expires_at : c.pending_expires_at)!.toISOString(),
            deviceId: c.status === "active" ? null : c.device_id,
          }
        : null,
  };
}
