import { fail, pass, type GuardRegistry } from "@/lib/lifecycle/guards";
import type { HookRegistry } from "@/lib/lifecycle/engine";

/**
 * The lifecycle guards and hooks owned by ballot-casting-core. They answer from the database
 * (sessions and counters), never from anything a terminal says.
 */
export const ballotGuards: GuardRegistry = {
  async noPendingBallot({ tx, boothId }) {
    const { rows } = await tx.query(
      "select 1 from public.ballot_sessions where booth_id = $1 and status = 'pending'",
      [boothId],
    );
    return rows.length > 0
      ? fail("a Ballot Session is pending; wait for the vote or cancel the ballot")
      : pass();
  },

  /**
   * At least one mock ballot was cast in the CURRENT mock round. The round's per-option mock
   * counts go into the Audit Event: mock votes are test data the Presiding Officer is meant
   * to see, and clearing excludes them from every count afterwards.
   */
  async mockBallotCast({ tx, boothId }) {
    const counter = await tx.query<{ mock_round: number }>(
      "select mock_round from public.booth_counters where booth_id = $1",
      [boothId],
    );
    const round = counter.rows[0]?.mock_round ?? 0;
    const sessions = await tx.query<{ n: string }>(
      `select count(*) n from public.ballot_sessions
        where booth_id = $1 and is_mock and mock_round = $2 and status = 'cast'`,
      [boothId, round],
    );
    const mockBallots = Number(sessions.rows[0]!.n);
    if (mockBallots === 0) return fail("no mock ballot has been cast in this mock poll");

    const counts = await tx.query<{
      post_id: string;
      candidate_id: string | null;
      is_nota: boolean;
      votes: string;
    }>("select post_id, candidate_id, is_nota, votes from public.mock_counts($1, $2)", [
      boothId,
      round,
    ]);
    return pass({
      mock_round: round,
      mock_ballots: mockBallots,
      mock_tally: counts.rows
        .map((r) => ({
          post_id: r.post_id,
          option: r.is_nota ? "NOTA" : r.candidate_id,
          count: Number(r.votes),
        }))
        .sort((a, b) => `${a.post_id}${a.option}`.localeCompare(`${b.post_id}${b.option}`)),
    });
  },

  async zeroRealBallots({ tx, boothId }) {
    const { rows } = await tx.query<{ ballots_cast: string }>(
      "select ballots_cast from public.booth_counters where booth_id = $1",
      [boothId],
    );
    return Number(rows[0]?.ballots_cast ?? 0) === 0
      ? pass()
      : fail("real ballots have already been cast at this booth");
  },
};

/** Entering Mock Poll starts a new mock round; its Vote Selections carry the round number. */
export const ballotHooks: HookRegistry = (["start_mock_poll", "repeat_mock_poll"] as const).map(
  (action) => ({
    action,
    async run(ctx, info) {
      const { rows } = await ctx.tx.query<{ mock_round: number }>(
        `update public.booth_counters set mock_round = mock_round + 1
          where booth_id = $1 returning mock_round`,
        [info.boothId],
      );
      return { mock_round: rows[0]!.mock_round };
    },
  }),
);
