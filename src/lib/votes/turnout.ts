import type { Pool } from "pg";
import { electionGrant, superAdminGrant, type Actor } from "@/lib/auth/roles";
import { CommandError } from "@/lib/commands/errors";

export interface BoothTurnout {
  boothId: string;
  name: string;
  state: string;
  ballotsCast: number;
  ballotsCancelled: number;
}

/**
 * Live turnout per booth: how many ballots were cast and cancelled. These totals are not
 * sealed (turnout is public); per-candidate counts are, and never appear here.
 * Readable by the Election's Returning Officer and Observers, and by a Super Admin.
 */
export async function getElectionTurnout(
  db: Pick<Pool, "query">,
  actor: Pick<Actor, "roles">,
  electionId: string,
): Promise<BoothTurnout[]> {
  const allowed =
    superAdminGrant(actor) ?? electionGrant(actor, electionId, ["returning_officer", "observer"]);
  if (!allowed) {
    throw new CommandError("forbidden", "You are not allowed to view this Election's turnout");
  }
  const { rows } = await db.query<{
    id: string;
    name: string;
    state: string;
    ballots_cast: string;
    ballots_cancelled: string;
  }>(
    `select b.id, b.name, s.state::text as state, c.ballots_cast, c.ballots_cancelled
       from public.booths b
       join public.booth_states s on s.booth_id = b.id
       join public.booth_counters c on c.booth_id = b.id
      where b.election_id = $1 order by b.name`,
    [electionId],
  );
  return rows.map((r) => ({
    boothId: r.id,
    name: r.name,
    state: r.state,
    ballotsCast: Number(r.ballots_cast),
    ballotsCancelled: Number(r.ballots_cancelled),
  }));
}
