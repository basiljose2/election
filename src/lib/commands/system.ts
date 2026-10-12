import { z } from "zod";
import { superAdminGrant } from "@/lib/auth/roles";
import type { Pool } from "pg";
import { CommandError } from "./errors";
import { defineCommand } from "./gateway";

/** What the Super Admin must type before all election data is erased. */
export const ERASE_PHRASE = "ERASE ALL DATA";

/**
 * Erases ALL election data (elections and everything under them, election-scoped roles and
 * the audit log). Test and rehearsal databases only: the database itself refuses unless its
 * owner switched `deployment_settings.allow_data_erase` on, a switch this application cannot
 * change. On top of that the actor must be a Super Admin with a fresh re-authentication and
 * must type the confirmation phrase. The erase is the first event of the new audit chain.
 */
export const eraseAllData = defineCommand({
  name: "system.data_erased",
  input: z.object({
    confirmation: z.string().refine((v) => v === ERASE_PHRASE, `Type ${ERASE_PHRASE} to confirm`),
  }),
  critical: true,
  authorize: (actor) => superAdminGrant(actor),
  describeTarget: () => ({ electionId: null, target: { type: "system", id: "election-data" } }),
  async execute(ctx) {
    let counts: Record<string, number>;
    try {
      const { rows } = await ctx.tx.query<{ counts: Record<string, number> }>(
        "select public.erase_all_election_data() as counts",
      );
      counts = rows[0]!.counts;
    } catch (error) {
      if (
        (error as { code?: string }).code === "42501" &&
        /not enabled/.test((error as Error).message)
      ) {
        throw new CommandError(
          "lifecycle",
          "Erasing data is not enabled for this database. It is a test and rehearsal feature that the database owner has to switch on.",
        );
      }
      throw error;
    }
    const { vote_selections: voteRows, ...rest } = counts;
    return {
      result: counts,
      audit: {
        electionId: null,
        target: { type: "system", id: "election-data" },
        // What existed just before, as totals only.
        before: { ...rest, vote_rows: voteRows ?? 0 },
        after: { erased: true },
        detail: { by: "super_admin" },
      },
    };
  },
});

export interface EraseStatus {
  /** The database owner has switched erasing on. */
  allowed: boolean;
  elections: number;
  booths: number;
  ballotsCast: number;
  results: number;
}

/** What the Super Admin sees before deciding. Totals only. */
export async function getEraseStatus(db: Pick<Pool, "query">): Promise<EraseStatus> {
  const [flag, elections, booths, cast, results] = await Promise.all([
    db.query<{ allow_data_erase: boolean }>(
      "select allow_data_erase from public.deployment_settings",
    ),
    db.query<{ n: string }>("select count(*) n from public.elections"),
    db.query<{ n: string }>("select count(*) n from public.booths"),
    db.query<{ n: string }>("select coalesce(sum(ballots_cast), 0) n from public.booth_counters"),
    db.query<{ n: string }>("select count(*) n from public.results"),
  ]);
  return {
    allowed: flag.rows[0]?.allow_data_erase ?? false,
    elections: Number(elections.rows[0]!.n),
    booths: Number(booths.rows[0]!.n),
    ballotsCast: Number(cast.rows[0]!.n),
    results: Number(results.rows[0]!.n),
  };
}
