import { computeEventHash } from "./chain";
import type { AuditExport } from "./export";

export type ChainVerification =
  { ok: true; eventCount: number } | { ok: false; reason: string; seq: number | null };

/**
 * Checks an exported chain the way the public verifier does: sequence numbers count up from
 * 1, each event links to the previous hash (the genesis for the first), and every hash
 * recomputes from its content.
 */
export function verifyAuditChain(doc: Pick<AuditExport, "genesis" | "events">): ChainVerification {
  let previous = doc.genesis;
  let expectedSeq = 1;
  for (const event of doc.events) {
    if (event.seq !== expectedSeq) {
      return { ok: false, reason: "sequence gap or reorder", seq: event.seq };
    }
    if (event.prev_hash !== previous) {
      return { ok: false, reason: "link to the previous event is broken", seq: event.seq };
    }
    if (computeEventHash(event) !== event.hash) {
      return { ok: false, reason: "event content does not match its hash", seq: event.seq };
    }
    previous = event.hash;
    expectedSeq += 1;
  }
  return { ok: true, eventCount: doc.events.length };
}
