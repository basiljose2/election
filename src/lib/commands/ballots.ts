import { z } from "zod";
import { boothGrant, type Actor } from "@/lib/auth/roles";
import type { Tx } from "@/lib/db/pool";
import { signalAfterCommit } from "@/lib/signals/publish";
import type { SignalPublisher } from "@/lib/signals/types";
import { verifyTerminalCredential } from "@/lib/terminals/credentials";
import { OFFLINE_AFTER_MS } from "@/lib/terminals/state";
import { CommandError } from "./errors";
import { defineCommand, type CommandContext } from "./gateway";
import { uuid } from "./setup-common";

/**
 * Presiding Officer commands for Ballot Sessions. Like the terminal commands they need BOTH
 * the Presiding Officer's staff session and the booth's registered Master Terminal credential.
 * Neither command touches Vote Selections.
 */

export const CANCEL_REASONS = ["voter_left", "voter_refused", "terminal_fault"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

const authorize = (actor: Actor, input: { boothId: string }) => boothGrant(actor, input.boothId);
const describeBooth = (input: { boothId: string }) => ({
  electionId: null,
  target: { type: "booth", id: input.boothId },
});
const masterToken = z.string().min(1, "This device is not registered as the Master Terminal");

async function requireMaster(ctx: CommandContext, boothId: string, token: string) {
  const check = await verifyTerminalCredential(ctx.tx, token, { type: "master", boothId });
  if (!check.ok) {
    throw new CommandError(
      "forbidden",
      "This device is not the registered Master Terminal of the booth",
    );
  }
  return check.terminal;
}

async function boothContext(tx: Tx, boothId: string) {
  const { rows } = await tx.query<{
    election_id: string;
    state: string;
    mock_round: number;
  }>(
    `select b.election_id, s.state::text as state, c.mock_round
       from public.booths b
       join public.booth_states s on s.booth_id = b.id
       join public.booth_counters c on c.booth_id = b.id
      where b.id = $1`,
    [boothId],
  );
  if (!rows[0]) throw new CommandError("not_found", "Polling Booth not found");
  return rows[0];
}

export function createBallotCommands(publisher: SignalPublisher) {
  /**
   * "Ballot": enables exactly one ballot on the booth's Voting Terminal. A real ballot needs
   * the booth Open; a mock ballot needs it in Mock Poll. The session is bound to the booth's
   * current Voting Terminal, which must be online, and only one can be pending at a time.
   */
  const issueBallotSession = defineCommand({
    name: "ballot.session_issued",
    input: z.object({ boothId: uuid, masterToken }),
    authorize,
    describeTarget: describeBooth,
    async execute(ctx, input) {
      await requireMaster(ctx, input.boothId, input.masterToken);
      const booth = await boothContext(ctx.tx, input.boothId);

      if (booth.state !== "open" && booth.state !== "mock_poll") {
        throw new CommandError(
          "lifecycle",
          "A ballot can be enabled only while the booth is Open or in a mock poll",
        );
      }
      const isMock = booth.state === "mock_poll";
      if (!isMock) {
        const election = await ctx.tx.query<{ status: string }>(
          "select status::text as status from public.elections where id = $1",
          [booth.election_id],
        );
        if (election.rows[0]?.status !== "polling_open") {
          throw new CommandError("lifecycle", "The Election is not Polling Open");
        }
      }

      const voting = await ctx.tx.query<{ id: string; last_seen_at: Date | null }>(
        `select t.id, h.last_seen_at from public.terminals t
           left join public.terminal_heartbeats h on h.terminal_id = t.id
          where t.booth_id = $1 and t.type = 'voting' and t.status = 'active'`,
        [input.boothId],
      );
      const terminal = voting.rows[0];
      if (!terminal)
        throw new CommandError("lifecycle", "No Voting Terminal is paired at this booth");
      const seen = terminal.last_seen_at;
      if (!seen || ctx.now().getTime() - seen.getTime() >= OFFLINE_AFTER_MS) {
        throw new CommandError("lifecycle", "The Voting Terminal is offline");
      }

      let sessionId: string;
      try {
        const inserted = await ctx.tx.query<{ id: string }>(
          `insert into public.ballot_sessions
             (election_id, booth_id, terminal_id, is_mock, mock_round, issued_by, issued_at)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [
            booth.election_id,
            input.boothId,
            terminal.id,
            isMock,
            isMock ? booth.mock_round : null,
            ctx.actor.userId,
            ctx.now(),
          ],
        );
        sessionId = inserted.rows[0]!.id;
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new CommandError("lifecycle", "A Ballot Session is already pending at this booth");
        }
        throw error;
      }
      await signalAfterCommit(ctx, publisher, input.boothId, "ballot-enabled");
      return {
        result: { sessionId, isMock },
        audit: {
          electionId: booth.election_id,
          target: { type: "ballot_session", id: sessionId },
          before: null,
          after: { booth_id: input.boothId, is_mock: isMock, status: "pending" },
          detail: { terminal_id: terminal.id, mock_round: isMock ? booth.mock_round : null },
        },
      };
    },
  });

  /**
   * Cancels the pending session: no Vote Selection is stored, the cancelled count goes up, the
   * Voting Terminal locks, and a later cast for the session is refused.
   */
  const cancelBallotSession = defineCommand({
    name: "ballot.session_cancelled",
    input: z.object({
      boothId: uuid,
      masterToken,
      reason: z.enum(CANCEL_REASONS),
      note: z.string().trim().max(300).optional(),
    }),
    authorize,
    describeTarget: describeBooth,
    async execute(ctx, input) {
      await requireMaster(ctx, input.boothId, input.masterToken);
      const booth = await boothContext(ctx.tx, input.boothId);
      const pending = await ctx.tx.query<{ id: string; is_mock: boolean }>(
        `select id, is_mock from public.ballot_sessions
          where booth_id = $1 and status = 'pending' for update`,
        [input.boothId],
      );
      const session = pending.rows[0];
      if (!session) throw new CommandError("lifecycle", "There is no pending ballot to cancel");

      await ctx.tx.query(
        `update public.ballot_sessions
            set status = 'cancelled', finished_at = $2, cancel_reason = $3, cancel_note = $4
          where id = $1`,
        [session.id, ctx.now(), input.reason, input.note || null],
      );
      await ctx.tx.query(
        "update public.booth_counters set ballots_cancelled = ballots_cancelled + 1 where booth_id = $1",
        [input.boothId],
      );
      await signalAfterCommit(ctx, publisher, input.boothId, "ballot-cancelled");
      return {
        result: { sessionId: session.id },
        audit: {
          electionId: booth.election_id,
          target: { type: "ballot_session", id: session.id },
          before: { status: "pending" },
          after: { status: "cancelled" },
          detail: { reason: input.reason, note: input.note ?? null, is_mock: session.is_mock },
        },
      };
    },
  });

  return { issueBallotSession, cancelBallotSession };
}

export type BallotCommands = ReturnType<typeof createBallotCommands>;
