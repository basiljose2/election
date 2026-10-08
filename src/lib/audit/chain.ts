import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "./canonical-json";

export const GENESIS_PREFIX = "campus-evm/audit-genesis/v1:";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Published genesis value: prev_hash of seq 1. Matches public.audit_genesis_hash(). */
export function genesisHash(electionId: string | null): string {
  return sha256Hex(GENESIS_PREFIX + (electionId ?? "system"));
}

export interface AuditActor {
  [key: string]: JsonValue;
  user_id: string | null;
  role: string | null;
  terminal_id: string | null;
}

export interface AuditTarget {
  [key: string]: JsonValue;
  type: string;
  id: string | null;
}

export interface AuditPayload {
  [key: string]: JsonValue;
  event_type: string;
  actor: AuditActor;
  target: AuditTarget;
  before: JsonValue;
  after: JsonValue;
  detail: JsonValue;
  occurred_at: string;
}

export interface ChainedEvent {
  election_id: string | null;
  seq: number;
  prev_hash: string;
  payload: AuditPayload;
}

export interface ExportedEvent extends ChainedEvent {
  hash: string;
}

/** hash = SHA-256( prev_hash || canonical_json({ election_id, seq, prev_hash, payload }) ) */
export function computeEventHash(event: ChainedEvent): string {
  const body = canonicalJson({
    election_id: event.election_id,
    seq: event.seq,
    prev_hash: event.prev_hash,
    payload: event.payload,
  });
  return sha256Hex(event.prev_hash + body);
}

// Keys that would carry ballot choices or link a Ballot Session to a Vote Selection.
const FORBIDDEN_KEYS = new Set([
  "candidate",
  "candidate_id",
  "candidate_ids",
  "choice",
  "choices",
  "selection",
  "selections",
  "vote_selection",
  "vote_selection_id",
  "vote_selection_ids",
  "nota",
]);

/** Audit Events must never contain vote choices (audit-log spec). */
export function assertNoChoiceData(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoChoiceData(item, `${path}[${i}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        throw new Error(`Audit Event must not contain choice data (${path}.${key})`);
      }
      assertNoChoiceData(child, `${path}.${key}`);
    }
  }
}
