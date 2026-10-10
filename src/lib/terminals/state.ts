import type { Pool } from "pg";
import type { AppendAuditEvent } from "@/lib/audit/append";
import { withTransaction } from "@/lib/db/pool";
import type { AuthenticatedTerminal } from "./credentials";
import { computeAllowedActions, type AllowedAction } from "./allowed-actions";
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
  electionName: string;
  boothName: string;
  /** Real ballots cast and cancelled at this booth (counts only; never a choice). */
  ballotsCast: number;
  ballotsCancelled: number;
  /** The current mock round's ballots; shown instead of the real counts during Mock Poll. */
  mock: { round: number; ballotsCast: number; ballotsCancelled: number };
  /** What the Master Terminal may offer now, with the reason for each refusal. */
  allowedActions: AllowedAction[];
  votingTerminal: {
    paired: boolean;
    deviceId: string | null;
    online: boolean;
    lastSeenAt: string | null;
    /** Milliseconds since the last heartbeat, as of this response. */
    lastSeenAgoMs: number | null;
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

  const counts = await deps.db.query<{
    election_name: string;
    election_status: string;
    booth_name: string;
    real_cast: string;
    real_cancelled: string;
    mock_round: number;
    mock_cast: string;
    mock_cancelled: string;
    master_active: boolean;
  }>(
    `select e.name as election_name, e.status::text as election_status, b.name as booth_name,
            public.booth_ballots_cast(b.id) as real_cast,
            (select count(*) from public.ballot_sessions s
              where s.booth_id = b.id and not s.is_mock and s.status = 'cancelled') as real_cancelled,
            c.mock_round,
            (select count(*) from public.ballot_sessions s
              where s.booth_id = b.id and s.is_mock and s.mock_round = c.mock_round
                and s.status = 'cast') as mock_cast,
            (select count(*) from public.ballot_sessions s
              where s.booth_id = b.id and s.is_mock and s.mock_round = c.mock_round
                and s.status = 'cancelled') as mock_cancelled,
            exists (select 1 from public.terminals t
                     where t.booth_id = b.id and t.type = 'master' and t.status = 'active')
              as master_active
       from public.booths b
       join public.elections e on e.id = b.election_id
       join public.booth_counters c on c.booth_id = b.id
      where b.id = $1`,
    [terminal.boothId],
  );
  const k = counts.rows[0]!;
  const realCast = Number(k.real_cast);
  const mockCast = Number(k.mock_cast);

  return {
    role: "master",
    ...common,
    electionName: k.election_name,
    boothName: k.booth_name,
    ballotsCast: realCast,
    ballotsCancelled: Number(k.real_cancelled),
    mock: {
      round: k.mock_round,
      ballotsCast: mockCast,
      ballotsCancelled: Number(k.mock_cancelled),
    },
    allowedActions: computeAllowedActions({
      boothState: row.booth_state,
      electionStatus: k.election_status,
      ballotPending: row.pending,
      masterActive: k.master_active,
      votingPaired: Boolean(v),
      votingOnline: online,
      realBallotsCast: realCast,
      mockBallotsCast: mockCast,
    }),
    votingTerminal: {
      paired: Boolean(v),
      deviceId: v?.device_id ?? null,
      online,
      lastSeenAt: v?.last_seen_at?.toISOString() ?? null,
      lastSeenAgoMs: v?.last_seen_at ? Math.max(0, now.getTime() - v.last_seen_at.getTime()) : null,
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
