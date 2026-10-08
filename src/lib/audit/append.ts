import type { PoolClient } from "pg";
import { canonicalJson, type JsonValue } from "./canonical-json";
import {
  assertNoChoiceData,
  computeEventHash,
  type AuditActor,
  type AuditPayload,
  type AuditTarget,
} from "./chain";

export interface AuditEventInput {
  electionId: string | null;
  eventType: string;
  actor: AuditActor;
  target: AuditTarget;
  before?: JsonValue;
  after?: JsonValue;
  detail?: JsonValue;
}

export interface AppendedEvent {
  electionId: string | null;
  seq: number;
  hash: string;
}

export type AppendAuditEvent = (tx: PoolClient, input: AuditEventInput) => Promise<AppendedEvent>;

/**
 * Appends one Audit Event inside the caller's transaction. The chain head is read under
 * a per-election advisory lock (held until the transaction ends), so concurrent appends
 * to one chain are serialised and the sequence has no gaps or forks.
 */
export const appendAuditEvent: AppendAuditEvent = async (tx, input) => {
  const head = await tx.query<{ last_seq: string; last_hash: string; occurred_at: string }>(
    "select last_seq, last_hash, occurred_at from public.audit_chain_head($1)",
    [input.electionId],
  );
  const row = head.rows[0];
  if (!row) throw new Error("audit_chain_head returned no row");

  const payload: AuditPayload = {
    event_type: input.eventType,
    actor: input.actor,
    target: input.target,
    before: input.before ?? null,
    after: input.after ?? null,
    detail: input.detail ?? null,
    occurred_at: row.occurred_at,
  };
  assertNoChoiceData(payload);

  const seq = Number(row.last_seq) + 1;
  const hash = computeEventHash({
    election_id: input.electionId,
    seq,
    prev_hash: row.last_hash,
    payload,
  });

  await tx.query(
    `insert into public.audit_events (election_id, seq, prev_hash, hash, payload)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [input.electionId, seq, row.last_hash, hash, canonicalJson(payload)],
  );

  return { electionId: input.electionId, seq, hash };
};

export const SYSTEM_ACTOR: AuditActor = { user_id: null, role: "system", terminal_id: null };
