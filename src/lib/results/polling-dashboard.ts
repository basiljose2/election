import type { Pool } from "pg";
import { electionGrant, superAdminGrant, type Actor } from "@/lib/auth/roles";
import { CommandError } from "@/lib/commands/errors";
import { isOnline } from "@/lib/terminals/state";

/**
 * The Returning Officer's polling dashboard: where every booth stands. Turnout totals are
 * public; per-candidate counts are sealed until declaration and never appear here (the
 * response has no such field, and a test pins the shape).
 */

export interface DashboardBooth {
  boothId: string;
  name: string;
  state: string;
  masterOnline: boolean;
  votingOnline: boolean;
  ballotsCast: number;
  ballotsCancelled: number;
  /** A Ballot Session is pending (the voter is, or was, at the kiosk). */
  ballotPending: boolean;
  /** ISO time of the booth's latest ballot activity, or null if none yet. */
  lastActivityAt: string | null;
}

export interface PollingDashboard {
  electionId: string;
  electionName: string;
  electionStatus: string;
  generatedAt: string;
  booths: DashboardBooth[];
  totals: {
    ballotsCast: number;
    ballotsCancelled: number;
    booths: number;
    boothsClosed: number;
  };
}

export async function getPollingDashboard(
  db: Pick<Pool, "query">,
  actor: Pick<Actor, "roles">,
  electionId: string,
  now: Date = new Date(),
): Promise<PollingDashboard> {
  const allowed =
    superAdminGrant(actor) ?? electionGrant(actor, electionId, ["returning_officer", "observer"]);
  if (!allowed) {
    throw new CommandError("forbidden", "You are not allowed to view this Election's dashboard");
  }

  const election = await db.query<{ name: string; status: string }>(
    "select name, status::text as status from public.elections where id = $1",
    [electionId],
  );
  if (!election.rows[0]) throw new CommandError("not_found", "Election not found");

  const { rows } = await db.query<{
    id: string;
    name: string;
    state: string;
    ballots_cast: string;
    ballots_cancelled: string;
    pending: boolean;
    last_activity: Date | null;
    master_seen: Date | null;
    voting_seen: Date | null;
  }>(
    `select b.id, b.name, s.state::text as state, c.ballots_cast, c.ballots_cancelled,
            exists (select 1 from public.ballot_sessions p
                     where p.booth_id = b.id and p.status = 'pending') as pending,
            (select max(coalesce(x.finished_at, x.issued_at))
               from public.ballot_sessions x where x.booth_id = b.id and not x.is_mock) as last_activity,
            (select h.last_seen_at from public.terminals t
               join public.terminal_heartbeats h on h.terminal_id = t.id
              where t.booth_id = b.id and t.type = 'master' and t.status = 'active') as master_seen,
            (select h.last_seen_at from public.terminals t
               join public.terminal_heartbeats h on h.terminal_id = t.id
              where t.booth_id = b.id and t.type = 'voting' and t.status = 'active') as voting_seen
       from public.booths b
       join public.booth_states s on s.booth_id = b.id
       join public.booth_counters c on c.booth_id = b.id
      where b.election_id = $1 order by b.name, b.id`,
    [electionId],
  );

  const booths = rows.map((r): DashboardBooth => ({
    boothId: r.id,
    name: r.name,
    state: r.state,
    masterOnline: isOnline(r.master_seen, now),
    votingOnline: isOnline(r.voting_seen, now),
    ballotsCast: Number(r.ballots_cast),
    ballotsCancelled: Number(r.ballots_cancelled),
    ballotPending: r.pending,
    lastActivityAt: r.last_activity?.toISOString() ?? null,
  }));
  return {
    electionId,
    electionName: election.rows[0].name,
    electionStatus: election.rows[0].status,
    generatedAt: now.toISOString(),
    booths,
    totals: {
      ballotsCast: booths.reduce((s, b) => s + b.ballotsCast, 0),
      ballotsCancelled: booths.reduce((s, b) => s + b.ballotsCancelled, 0),
      booths: booths.length,
      boothsClosed: booths.filter((b) => b.state === "closed" || b.state === "sealed").length,
    },
  };
}
