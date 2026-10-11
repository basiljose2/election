import type { Pool } from "pg";
import { electionGrant, superAdminGrant, type Actor } from "@/lib/auth/roles";
import { CommandError } from "@/lib/commands/errors";

export interface FeedEvent {
  seq: number;
  occurredAt: string;
  eventType: string;
  actorRole: string | null;
  targetType: string;
  targetId: string;
}

export const FEED_PAGE_SIZE = 200;

/**
 * The Election's Audit Events after `afterSeq`, oldest first, for Observers (and the
 * Returning Officer and Super Admin). Audit Events never contain choices, and this view
 * shows only who-did-what-to-what: type, time, role and target.
 */
export async function getAuditFeed(
  db: Pick<Pool, "query">,
  actor: Pick<Actor, "roles">,
  electionId: string,
  afterSeq: number,
): Promise<{ events: FeedEvent[]; lastSeq: number }> {
  const allowed =
    superAdminGrant(actor) ?? electionGrant(actor, electionId, ["observer", "returning_officer"]);
  if (!allowed) {
    throw new CommandError("forbidden", "You are not allowed to follow this Election's audit log");
  }
  const { rows } = await db.query<{
    seq: string;
    payload: {
      event_type: string;
      occurred_at: string;
      actor?: { role?: string | null };
      target?: { type?: string; id?: string };
    };
  }>(
    `select seq, payload from public.audit_events
      where chain_key = $1::uuid and seq > $2
      order by seq limit ${FEED_PAGE_SIZE}`,
    [electionId, afterSeq],
  );
  const events = rows.map((r) => ({
    seq: Number(r.seq),
    occurredAt: r.payload.occurred_at,
    eventType: r.payload.event_type,
    actorRole: r.payload.actor?.role ?? null,
    targetType: r.payload.target?.type ?? "",
    targetId: r.payload.target?.id ?? "",
  }));
  return { events, lastSeq: events.at(-1)?.seq ?? afterSeq };
}
