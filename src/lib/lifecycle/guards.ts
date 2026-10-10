import type { JsonValue } from "@/lib/audit/canonical-json";
import type { Actor } from "@/lib/auth/roles";
import type { Tx } from "@/lib/db/pool";
import { OFFLINE_AFTER_MS } from "@/lib/terminals/state";
import type { GuardName } from "./tables";

/**
 * Guards are named checks that a transition runs inside its transaction. Each change that owns
 * the data a guard needs registers it. A guard nobody has registered FAILS CLOSED: the
 * transition is refused with a clear message instead of being allowed by accident.
 */

export interface GuardContext {
  tx: Tx;
  now: Date;
  electionId: string;
  /** Present for booth transitions. */
  boothId: string | null;
  actor: Actor;
}

export type GuardResult =
  | { ok: true; /** Extra facts to record in the transition's Audit Event. */ audit?: JsonValue }
  | { ok: false; message: string };

export type Guard = (ctx: GuardContext) => Promise<GuardResult>;
export type GuardRegistry = Partial<Record<GuardName, Guard>>;

export const pass = (audit?: JsonValue): GuardResult => ({ ok: true, ...(audit ? { audit } : {}) });
export const fail = (message: string): GuardResult => ({ ok: false, message });

/** Runs every guard of a transition (all of them, so the caller sees every reason at once). */
export async function runGuards(
  names: readonly GuardName[],
  registry: GuardRegistry,
  ctx: GuardContext,
): Promise<{ failures: string[]; audit: Record<string, JsonValue> }> {
  const failures: string[] = [];
  const audit: Record<string, JsonValue> = {};
  for (const name of names) {
    const guard = registry[name];
    if (!guard) {
      failures.push(`the "${name}" check is not available yet, so this action is blocked`);
      continue;
    }
    const result = await guard(ctx);
    if (!result.ok) failures.push(result.message);
    else if (result.audit !== undefined) audit[name] = result.audit;
  }
  return { failures, audit };
}

async function electionStatus(ctx: GuardContext): Promise<string> {
  const { rows } = await ctx.tx.query<{ status: string }>(
    "select status::text as status from public.elections where id = $1",
    [ctx.electionId],
  );
  return rows[0]?.status ?? "missing";
}

async function activeTerminal(ctx: GuardContext, type: "master" | "voting") {
  const { rows } = await ctx.tx.query<{ id: string }>(
    `select id from public.terminals where booth_id = $1 and type = $2 and status = 'active'`,
    [ctx.boothId, type],
  );
  return rows[0]?.id ?? null;
}

/**
 * Guards implemented by this change and by realtime-device-pairing. The ballot-related guards
 * (noPendingBallot, mockBallotCast, zeroRealBallots) belong to ballot-casting-core and the
 * results guard to results-dashboard; until they register, they fail closed.
 */
export const defaultGuards: GuardRegistry = {
  async electionFrozenOrOpen(ctx) {
    const status = await electionStatus(ctx);
    return status === "frozen" || status === "polling_open"
      ? pass()
      : fail("the Election must be Frozen or Polling Open");
  },

  async electionPollingOpen(ctx) {
    return (await electionStatus(ctx)) === "polling_open"
      ? pass()
      : fail("the Election is not Polling Open yet");
  },

  async allBoothsClosed(ctx) {
    const { rows } = await ctx.tx.query<{ name: string; state: string }>(
      `select b.name, s.state::text as state
         from public.booths b join public.booth_states s on s.booth_id = b.id
        where b.election_id = $1 and s.state <> 'closed' order by b.name`,
      [ctx.electionId],
    );
    if (rows.length === 0) return pass();
    return fail(
      rows.map((r) => `Booth "${r.name}" is ${r.state.replace("_", " ")}, not Closed`).join("; "),
    );
  },

  async masterTerminalActive(ctx) {
    return (await activeTerminal(ctx, "master"))
      ? pass()
      : fail("the booth has no active Master Terminal");
  },

  async votingTerminalActive(ctx) {
    return (await activeTerminal(ctx, "voting"))
      ? pass()
      : fail("the booth has no paired Voting Terminal");
  },

  async votingTerminalOnline(ctx) {
    const { rows } = await ctx.tx.query<{ last_seen_at: Date | null }>(
      `select h.last_seen_at from public.terminals t
         left join public.terminal_heartbeats h on h.terminal_id = t.id
        where t.booth_id = $1 and t.type = 'voting' and t.status = 'active'`,
      [ctx.boothId],
    );
    const seen = rows[0]?.last_seen_at;
    return seen && ctx.now.getTime() - seen.getTime() < OFFLINE_AFTER_MS
      ? pass()
      : fail("the Voting Terminal is offline");
  },
};
