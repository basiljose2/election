import type { Pool } from "pg";
import { electionGrant, superAdminGrant, type Actor } from "@/lib/auth/roles";
import { ELECTION_COLUMNS, type ElectionRow } from "./load";

/**
 * Elections visible to this actor: all for a Super Admin; otherwise only the Elections they
 * hold a role in (Returning Officer, Observer or Presiding Officer). Other Elections never
 * appear.
 */
export async function listElections(
  db: Pick<Pool, "query">,
  actor: Pick<Actor, "roles">,
): Promise<ElectionRow[]> {
  const all = !!superAdminGrant(actor);
  const ids = [...new Set(actor.roles.flatMap((r) => (r.electionId ? [r.electionId] : [])))];
  if (!all && ids.length === 0) return [];
  const { rows } = await db.query<ElectionRow>(
    `select ${ELECTION_COLUMNS} from public.elections
      where $1::boolean or id = any($2::uuid[])
      order by polling_date desc, name`,
    [all, ids],
  );
  return rows;
}

/** True if the actor may configure (edit/freeze) this Election. */
export const canConfigure = (actor: Pick<Actor, "roles">, electionId: string): boolean =>
  electionGrant(actor, electionId, ["returning_officer"]) !== null;

export interface PostView {
  id: string;
  name: string;
  seats: number;
  uncontested: boolean;
  candidates: Array<{
    id: string;
    name: string;
    photo_hash: string | null;
    symbol_hash: string | null;
    symbol_text: string | null;
  }>;
}

export interface BoothView {
  id: string;
  name: string;
  location: string;
  post_ids: string[];
  presiding_officer: string | null;
}

export interface SetupView {
  election: ElectionRow;
  posts: PostView[];
  booths: BoothView[];
  latestSnapshot: { freeze_no: number; setup_hash: string } | null;
}

export async function loadSetupView(
  db: Pick<Pool, "query">,
  electionId: string,
): Promise<SetupView | null> {
  const election = await db.query<ElectionRow>(
    `select ${ELECTION_COLUMNS} from public.elections where id = $1`,
    [electionId],
  );
  if (!election.rows[0]) return null;

  const posts = await db.query<PostView>(
    `select p.id, p.name, p.seats, p.uncontested,
            coalesce(json_agg(json_build_object(
              'id', c.id, 'name', c.name, 'photo_hash', c.photo_hash,
              'symbol_hash', c.symbol_hash, 'symbol_text', c.symbol_text)
              order by c.sort_order, c.id) filter (where c.id is not null), '[]') as candidates
       from public.posts p
       left join public.candidates c on c.post_id = p.id
      where p.election_id = $1
      group by p.id
      order by p.display_order, p.id`,
    [electionId],
  );
  const booths = await db.query<BoothView>(
    `select b.id, b.name, b.location,
            coalesce((select array_agg(bp.post_id) from public.booth_posts bp where bp.booth_id = b.id), '{}') as post_ids,
            (select s.display_name from public.staff_roles r join public.staff s on s.user_id = r.user_id
              where r.booth_id = b.id and r.role = 'presiding_officer' and r.revoked_at is null
              limit 1) as presiding_officer
       from public.booths b where b.election_id = $1 order by b.name, b.id`,
    [electionId],
  );
  const snapshot = await db.query<{ freeze_no: number; setup_hash: string }>(
    `select freeze_no, setup_hash from public.setup_snapshots
      where election_id = $1 order by freeze_no desc limit 1`,
    [electionId],
  );
  return {
    election: election.rows[0],
    posts: posts.rows,
    booths: booths.rows,
    latestSnapshot: snapshot.rows[0] ?? null,
  };
}
