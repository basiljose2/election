import { z } from "zod";
import type { JsonValue } from "@/lib/audit/canonical-json";
import {
  boothGrant,
  electionGrant,
  superAdminGrant,
  type Actor,
  type RoleAssignment,
} from "@/lib/auth/roles";
import { CommandError } from "@/lib/commands/errors";
import { defineCommand, type CommandContext } from "@/lib/commands/gateway";
import { uuid } from "@/lib/commands/setup-common";
import { signalAfterCommit } from "@/lib/signals/publish";
import type { SignalPublisher } from "@/lib/signals/types";
import { defaultGuards, runGuards, type GuardRegistry } from "./guards";
import {
  BOOTH_TRANSITIONS,
  ELECTION_TRANSITIONS,
  findTransition,
  type BoothAction,
  type BoothState,
  type ElectionAction,
  type ElectionState,
  type TransitionRow,
} from "./tables";

/**
 * The single authority that answers "is this allowed now?" for Elections and Polling Booths.
 *
 * Every transition runs as one command (so one database transaction):
 *   authenticate → authorize (role from the table) → [re-auth] → lock the row → check the
 *   current state against the table → run the guards → compare-and-set → hooks → state
 *   version + after-commit signal → Audit Event.
 *
 * Two identical requests at once serialise on the row lock; the second sees the new state and
 * is rejected as an invalid transition.
 */

const label = (action: string) => action.replace(/_/g, " ");

/** Audit event types (past tense, like election.frozen). */
export const EVENT_NAMES: Record<string, string> = {
  start_polling: "election.polling_started",
  complete_polls: "election.polls_completed",
  declare_results: "election.results_declared",
  archive: "election.archived",
  start_mock_poll: "booth.mock_poll_started",
  clear_mock_poll: "booth.mock_poll_cleared",
  repeat_mock_poll: "booth.mock_poll_repeated",
  open_poll: "booth.poll_opened",
  close_poll: "booth.poll_closed",
  force_close_poll: "booth.poll_force_closed",
};

export interface TransitionInfo {
  scope: "election" | "booth";
  action: string;
  from: string;
  to: string;
  electionId: string;
  boothId: string | null;
  reason: string | null;
}

/** Runs inside the transition's transaction; whatever it returns is recorded in the Audit Event. */
export type TransitionHook = (
  ctx: CommandContext,
  info: TransitionInfo,
) => Promise<JsonValue | undefined>;

export type HookRegistry = Array<{ action: string; run: TransitionHook }>;

/** Hooks other changes register for their side effects; this one supplies the force-close cleanup. */
export const defaultHooks: HookRegistry = [
  {
    action: "force_close_poll",
    async run(ctx, info) {
      const { rows } = await ctx.tx.query<{ n: number }>(
        "select public.cancel_pending_ballot_sessions($1) as n",
        [info.boothId],
      );
      return { cancelled_ballot_sessions: rows[0]!.n };
    },
  },
];

export interface LifecycleDeps {
  publisher: SignalPublisher;
  guards?: GuardRegistry;
  hooks?: HookRegistry;
}

function grantFor(
  actor: Actor,
  roles: TransitionRow<string, string>["allowedRoles"],
  electionId: string,
  boothId: string | null,
): RoleAssignment | null {
  for (const role of roles) {
    if (role === "super_admin") {
      const grant = superAdminGrant(actor);
      if (grant) return grant;
    } else if (role === "returning_officer") {
      const grant = electionGrant(actor, electionId, ["returning_officer"]);
      if (grant) return grant;
    } else if (role === "presiding_officer" && boothId) {
      const grant = boothGrant(actor, boothId);
      // The booth belongs to the Election named in the request.
      if (grant && grant.electionId === electionId) return grant;
    }
  }
  return null;
}

const reasonField = z.string().trim().max(500).optional();

async function runHooks(
  hooks: HookRegistry,
  ctx: CommandContext,
  info: TransitionInfo,
): Promise<JsonValue[]> {
  const out: JsonValue[] = [];
  for (const hook of hooks.filter((h) => h.action === info.action)) {
    const result = await hook.run(ctx, info);
    if (result !== undefined) out.push(result);
  }
  return out;
}

export function createLifecycleCommands(deps: LifecycleDeps) {
  const guards = deps.guards ?? defaultGuards;
  const hooks = deps.hooks ?? defaultHooks;

  function electionCommand(action: ElectionAction) {
    const rows = ELECTION_TRANSITIONS.filter((r) => r.action === action);
    const first = rows[0]!;
    return defineCommand({
      name: EVENT_NAMES[action]!,
      input: z.object({ electionId: uuid }),
      critical: first.requiresReauth,
      authorize: (actor, input) => grantFor(actor, first.allowedRoles, input.electionId, null),
      describeTarget: (input) => ({
        electionId: input.electionId,
        target: { type: "election", id: input.electionId },
      }),
      async execute(ctx, input) {
        const locked = await ctx.tx.query<{ status: ElectionState }>(
          "select status::text as status from public.elections where id = $1 for update",
          [input.electionId],
        );
        if (!locked.rows[0]) throw new CommandError("not_found", "Election not found");
        const from = locked.rows[0].status;
        const row = findTransition(ELECTION_TRANSITIONS, from, action);
        if (!row) {
          throw new CommandError(
            "invalid_transition",
            `Cannot ${label(action)}: the Election is ${label(from)}`,
          );
        }

        const { failures, audit } = await runGuards(row.guards, guards, {
          tx: ctx.tx,
          now: ctx.now(),
          electionId: input.electionId,
          boothId: null,
          actor: ctx.actor,
        });
        if (failures.length > 0) {
          throw new CommandError("lifecycle", `Cannot ${label(action)}: ${failures.join("; ")}`);
        }

        // Completing all polls seals every (Closed) booth in the same transaction.
        const sealed =
          action === "complete_polls"
            ? (
                await ctx.tx.query<{ booth_id: string }>(
                  `update public.booth_states s set state = 'sealed'
                     from public.booths b
                    where b.id = s.booth_id and b.election_id = $1 and s.state = 'closed'
                returning s.booth_id`,
                  [input.electionId],
                )
              ).rows.map((r) => r.booth_id)
            : [];

        await ctx.tx.query("update public.elections set status = $2 where id = $1", [
          input.electionId,
          row.to,
        ]);

        const info: TransitionInfo = {
          scope: "election",
          action,
          from,
          to: row.to,
          electionId: input.electionId,
          boothId: null,
          reason: null,
        };
        const hookDetail = await runHooks(hooks, ctx, info);

        // Every booth's terminals re-fetch state: the Election's state is part of it.
        const booths = await ctx.tx.query<{ id: string }>(
          "select id from public.booths where election_id = $1",
          [input.electionId],
        );
        for (const booth of booths.rows) {
          await signalAfterCommit(ctx, deps.publisher, booth.id, "booth-state-changed");
        }

        return {
          result: { from, to: row.to },
          audit: {
            electionId: input.electionId,
            target: { type: "election", id: input.electionId },
            before: { status: from },
            after: { status: row.to },
            detail: {
              action,
              guards: audit,
              sealed_booths: sealed,
              hooks: hookDetail,
            },
          },
        };
      },
    });
  }

  function boothCommand(action: BoothAction) {
    const first = BOOTH_TRANSITIONS.find((r) => r.action === action)!;
    return defineCommand({
      name: EVENT_NAMES[action]!,
      input: z.object({ electionId: uuid, boothId: uuid, reason: reasonField }),
      critical: first.requiresReauth,
      authorize: (actor, input) =>
        grantFor(actor, first.allowedRoles, input.electionId, input.boothId),
      describeTarget: (input) => ({
        electionId: input.electionId,
        target: { type: "booth", id: input.boothId },
      }),
      async execute(ctx, input) {
        const locked = await ctx.tx.query<{ state: BoothState; election_id: string }>(
          `select s.state::text as state, b.election_id
             from public.booth_states s join public.booths b on b.id = s.booth_id
            where s.booth_id = $1 for update of s`,
          [input.boothId],
        );
        const booth = locked.rows[0];
        // A booth of another Election is "not found" under this Election's grant.
        if (!booth || booth.election_id !== input.electionId) {
          throw new CommandError("not_found", "Polling Booth not found");
        }
        const row = findTransition(BOOTH_TRANSITIONS, booth.state, action);
        if (!row) {
          throw new CommandError(
            "invalid_transition",
            `Cannot ${label(action)}: the booth is ${label(booth.state)}`,
          );
        }
        if (row.requiresReason && (input.reason?.length ?? 0) < 3) {
          throw new CommandError("invalid_input", "A written reason is required");
        }

        // Read the Election's state under a share lock so it cannot change mid-transition.
        await ctx.tx.query("select 1 from public.elections where id = $1 for share", [
          input.electionId,
        ]);
        const { failures, audit } = await runGuards(row.guards, guards, {
          tx: ctx.tx,
          now: ctx.now(),
          electionId: input.electionId,
          boothId: input.boothId,
          actor: ctx.actor,
        });
        if (failures.length > 0) {
          throw new CommandError("lifecycle", `Cannot ${label(action)}: ${failures.join("; ")}`);
        }

        await ctx.tx.query("update public.booth_states set state = $2 where booth_id = $1", [
          input.boothId,
          row.to,
        ]);
        const info: TransitionInfo = {
          scope: "booth",
          action,
          from: booth.state,
          to: row.to,
          electionId: input.electionId,
          boothId: input.boothId,
          reason: input.reason ?? null,
        };
        const hookDetail = await runHooks(hooks, ctx, info);
        const version = await signalAfterCommit(
          ctx,
          deps.publisher,
          input.boothId,
          "booth-state-changed",
        );

        return {
          result: { from: booth.state, to: row.to, version },
          audit: {
            electionId: input.electionId,
            target: { type: "booth", id: input.boothId },
            before: { state: booth.state },
            after: { state: row.to, version },
            detail: {
              action,
              ...(input.reason ? { reason: input.reason } : {}),
              guards: audit,
              hooks: hookDetail,
            },
          },
        };
      },
    });
  }

  return {
    startPolling: electionCommand("start_polling"),
    completePolls: electionCommand("complete_polls"),
    declareResults: electionCommand("declare_results"),
    archive: electionCommand("archive"),
    startMockPoll: boothCommand("start_mock_poll"),
    clearMockPoll: boothCommand("clear_mock_poll"),
    repeatMockPoll: boothCommand("repeat_mock_poll"),
    openPoll: boothCommand("open_poll"),
    closePoll: boothCommand("close_poll"),
    forceClosePoll: boothCommand("force_close_poll"),
  };
}

export type LifecycleCommands = ReturnType<typeof createLifecycleCommands>;
