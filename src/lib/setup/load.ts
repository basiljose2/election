import type { Pool, PoolClient } from "pg";
import { CommandError } from "@/lib/commands/errors";
import type { SetupData } from "./freeze";

type Queryable = Pick<Pool | PoolClient, "query">;

export interface ElectionRow {
  id: string;
  name: string;
  description: string;
  polling_date: string;
  nota_enabled: boolean;
  status: "draft" | "frozen";
  freeze_count: number;
}

export const ELECTION_COLUMNS = `id, name, description, polling_date::text as polling_date,
  nota_enabled, status, freeze_count`;

export async function loadElection(db: Queryable, electionId: string): Promise<ElectionRow> {
  const { rows } = await db.query<ElectionRow>(
    `select ${ELECTION_COLUMNS} from public.elections where id = $1`,
    [electionId],
  );
  if (!rows[0]) throw new CommandError("not_found", "Election not found");
  return rows[0];
}

/** The whole live setup of one Election, as input to freeze validation and snapshotting. */
export async function loadSetupData(db: Queryable, electionId: string): Promise<SetupData> {
  const election = await loadElection(db, electionId);

  const posts = await db.query<{
    id: string;
    name: string;
    seats: number;
    display_order: number;
  }>(
    `select id, name, seats, display_order from public.posts
      where election_id = $1 order by display_order, id`,
    [electionId],
  );
  const candidates = await db.query<{
    id: string;
    post_id: string;
    name: string;
    sort_order: number;
    photo_hash: string | null;
    symbol_hash: string | null;
    symbol_text: string | null;
  }>(
    `select id, post_id, name, sort_order, photo_hash, symbol_hash, symbol_text
       from public.candidates where election_id = $1 order by sort_order, id`,
    [electionId],
  );
  const booths = await db.query<{
    id: string;
    name: string;
    location: string;
    presiding_officers: string;
  }>(
    `select b.id, b.name, b.location,
            (select count(*) from public.staff_roles r
               join public.staff s on s.user_id = r.user_id
              where r.booth_id = b.id and r.role = 'presiding_officer'
                and r.revoked_at is null and s.active) as presiding_officers
       from public.booths b where b.election_id = $1 order by b.name, b.id`,
    [electionId],
  );
  const mappings = await db.query<{ booth_id: string; post_id: string }>(
    "select booth_id, post_id from public.booth_posts where election_id = $1",
    [electionId],
  );

  return {
    election: {
      id: election.id,
      name: election.name,
      description: election.description,
      pollingDate: election.polling_date,
      notaEnabled: election.nota_enabled,
    },
    posts: posts.rows.map((p) => ({
      id: p.id,
      name: p.name,
      seats: p.seats,
      displayOrder: p.display_order,
      candidates: candidates.rows
        .filter((c) => c.post_id === p.id)
        .map((c) => ({
          id: c.id,
          name: c.name,
          sortOrder: c.sort_order,
          photoHash: c.photo_hash,
          symbolHash: c.symbol_hash,
          symbolText: c.symbol_text,
        })),
    })),
    booths: booths.rows.map((b) => ({
      id: b.id,
      name: b.name,
      location: b.location,
      presidingOfficers: Number(b.presiding_officers),
      postIds: mappings.rows.filter((m) => m.booth_id === b.id).map((m) => m.post_id),
    })),
  };
}
