import type { Pool } from "pg";
import { canonicalJson } from "./canonical-json";
import { genesisHash, type AuditPayload, type ExportedEvent } from "./chain";

export const AUDIT_EXPORT_FORMAT = "campus-evm-audit-export/v1";

export const AUDIT_EXPORT_ALGORITHM = {
  canonical_json:
    "UTF-8 JSON, object keys sorted by UTF-16 code units (RFC 8785 order), no insignificant whitespace, strings escaped as ECMAScript JSON.stringify, integers only, timestamps as ISO-8601 UTC strings",
  genesis:
    "prev_hash of seq 1 = hex(SHA-256(UTF-8('campus-evm/audit-genesis/v1:' + (election_id ?? 'system'))))",
  hash: "hash = hex(SHA-256(UTF-8(prev_hash + canonical_json({ election_id, seq, prev_hash, payload }))))",
  sequence:
    "seq starts at 1 and increases by exactly 1; each prev_hash equals the previous event's hash",
  documentation: "docs/AUDIT_FORMAT.md",
} as const;

export interface AuditExport {
  format: typeof AUDIT_EXPORT_FORMAT;
  algorithm: typeof AUDIT_EXPORT_ALGORITHM;
  election_id: string | null;
  genesis: string;
  event_count: number;
  head_hash: string;
  events: ExportedEvent[];
}

export async function buildAuditExport(
  db: Pick<Pool, "query">,
  electionId: string | null,
): Promise<AuditExport> {
  const { rows } = await db.query<{
    election_id: string | null;
    seq: string;
    prev_hash: string;
    hash: string;
    payload: AuditPayload;
  }>(
    `select election_id, seq, prev_hash, hash, payload from public.audit_events
      where chain_key = coalesce($1::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      order by seq`,
    [electionId],
  );
  const genesis = genesisHash(electionId);
  const events = rows.map((r) => ({
    election_id: r.election_id,
    seq: Number(r.seq),
    prev_hash: r.prev_hash,
    hash: r.hash,
    payload: r.payload,
  }));
  return {
    format: AUDIT_EXPORT_FORMAT,
    algorithm: AUDIT_EXPORT_ALGORITHM,
    election_id: electionId,
    genesis,
    event_count: events.length,
    head_hash: events.at(-1)?.hash ?? genesis,
    events,
  };
}

export function serializeAuditExport(doc: AuditExport): string {
  return canonicalJson(doc);
}
