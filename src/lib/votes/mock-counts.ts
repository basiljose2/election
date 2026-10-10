import type { Pool } from "pg";
import { boothGrant, type Actor } from "@/lib/auth/roles";
import { CommandError } from "@/lib/commands/errors";

export interface MockCounts {
  /** The booth's current mock poll round; earlier rounds are never shown. */
  round: number;
  mockBallots: number;
  options: Array<{
    postId: string;
    postName: string;
    candidateId: string | null;
    isNota: boolean;
    name: string;
    votes: number;
  }>;
}

/**
 * Per-option mock counts of the booth's CURRENT mock round, for that booth's Presiding Officer
 * only. Reads go through the sealed `mock_counts` function, which returns mock rows only, so
 * real votes can never appear here.
 */
export async function getMockCounts(
  db: Pick<Pool, "query">,
  actor: Pick<Actor, "roles">,
  boothId: string,
): Promise<MockCounts> {
  if (!boothGrant(actor, boothId)) {
    throw new CommandError("forbidden", "You are not the Presiding Officer of this booth");
  }
  const counter = await db.query<{ mock_round: number }>(
    "select mock_round from public.booth_counters where booth_id = $1",
    [boothId],
  );
  const round = counter.rows[0]?.mock_round ?? 0;
  if (!counter.rows[0] || round === 0) return { round, mockBallots: 0, options: [] };

  const ballots = await db.query<{ n: string }>(
    `select count(*) n from public.ballot_sessions
      where booth_id = $1 and is_mock and mock_round = $2 and status = 'cast'`,
    [boothId, round],
  );
  const counts = await db.query<{
    post_id: string;
    candidate_id: string | null;
    is_nota: boolean;
    votes: string;
    post_name: string;
    candidate_name: string | null;
  }>(
    `select m.post_id, m.candidate_id, m.is_nota, m.votes, p.name as post_name,
            c.name as candidate_name
       from public.mock_counts($1, $2) m
       join public.posts p on p.id = m.post_id
       left join public.candidates c on c.id = m.candidate_id
      order by p.display_order, c.sort_order nulls last`,
    [boothId, round],
  );
  return {
    round,
    mockBallots: Number(ballots.rows[0]!.n),
    options: counts.rows.map((r) => ({
      postId: r.post_id,
      postName: r.post_name,
      candidateId: r.candidate_id,
      isNota: r.is_nota,
      name: r.is_nota ? "NOTA" : (r.candidate_name ?? ""),
      votes: Number(r.votes),
    })),
  };
}
