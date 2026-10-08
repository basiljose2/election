#!/usr/bin/env node
// Standalone verifier for Campus EVM audit exports (campus-evm-audit-export/v1).
//
// Deliberately self-contained: it depends only on Node's standard library and does not
// import any application code, so a third party can audit it and run it offline.
//
//   node verify-audit.mjs <export.json>      exit 0 = valid, 1 = invalid, 2 = usage error
//
// Algorithm (docs/AUDIT_FORMAT.md):
//   genesis   = hex(SHA-256("campus-evm/audit-genesis/v1:" + (election_id ?? "system")))
//   hash(e)   = hex(SHA-256(e.prev_hash + canonical_json({election_id, seq, prev_hash, payload})))
//   seq runs 1, 2, 3, ... and each prev_hash equals the previous event's hash.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const FORMAT = "campus-evm-audit-export/v1";
const GENESIS_PREFIX = "campus-evm/audit-genesis/v1:";

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");

export function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError(`non-integer number ${value}`);
      return Object.is(value, -0) ? "0" : String(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      return `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
        .join(",")}}`;
    default:
      throw new TypeError(`unsupported JSON type ${typeof value}`);
  }
}

export const genesisHash = (electionId) => sha256Hex(GENESIS_PREFIX + (electionId ?? "system"));

export function eventHash(event) {
  const body = canonicalJson({
    election_id: event.election_id,
    seq: event.seq,
    prev_hash: event.prev_hash,
    payload: event.payload,
  });
  return sha256Hex(event.prev_hash + body);
}

/**
 * Verifies an export document. Returns { ok: true, count, head } or
 * { ok: false, seq, reason } where seq is the first mismatching sequence number.
 */
export function verifyAuditExport(doc) {
  if (!doc || typeof doc !== "object") return { ok: false, seq: null, reason: "not an object" };
  if (doc.format !== FORMAT)
    return { ok: false, seq: null, reason: `unknown format ${doc.format}` };
  if (!Array.isArray(doc.events)) return { ok: false, seq: null, reason: "events is not an array" };

  const electionId = doc.election_id ?? null;
  let prevHash = genesisHash(electionId);
  if (doc.genesis !== undefined && doc.genesis !== prevHash) {
    return { ok: false, seq: 1, reason: "genesis does not match the published genesis value" };
  }

  for (let i = 0; i < doc.events.length; i++) {
    const expectedSeq = i + 1;
    const e = doc.events[i];
    if (!e || typeof e !== "object") {
      return { ok: false, seq: expectedSeq, reason: "event is not an object" };
    }
    if (e.seq !== expectedSeq) {
      return {
        ok: false,
        seq: expectedSeq,
        reason: `expected seq ${expectedSeq}, found ${e.seq} (event missing or out of order)`,
      };
    }
    if ((e.election_id ?? null) !== electionId) {
      return { ok: false, seq: expectedSeq, reason: "event belongs to another chain" };
    }
    if (e.prev_hash !== prevHash) {
      return { ok: false, seq: expectedSeq, reason: "prev_hash does not match the previous event" };
    }
    let recomputed;
    try {
      recomputed = eventHash(e);
    } catch (error) {
      return { ok: false, seq: expectedSeq, reason: `cannot canonicalise event: ${error.message}` };
    }
    if (recomputed !== e.hash) {
      return { ok: false, seq: expectedSeq, reason: "hash does not match the event content" };
    }
    prevHash = e.hash;
  }

  if (doc.event_count !== undefined && doc.event_count !== doc.events.length) {
    return { ok: false, seq: doc.events.length + 1, reason: "event_count does not match" };
  }
  if (doc.head_hash !== undefined && doc.head_hash !== prevHash) {
    return { ok: false, seq: doc.events.length, reason: "head_hash does not match the last event" };
  }
  return { ok: true, count: doc.events.length, head: prevHash };
}

function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error("usage: node verify-audit.mjs <audit-export.json>");
    return 2;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`cannot read ${file}: ${error.message}`);
    return 2;
  }
  const result = verifyAuditExport(doc);
  const chain = doc.election_id ?? "system";
  if (result.ok) {
    console.log(`OK  chain ${chain}: ${result.count} events, head ${result.head}`);
    return 0;
  }
  console.log(`FAIL chain ${chain}: first mismatch at seq ${result.seq}: ${result.reason}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv);
}
