import { describe, expect, it } from "vitest";
import {
  assertNoChoiceData,
  computeEventHash,
  genesisHash,
  sha256Hex,
  type AuditPayload,
} from "./chain";

const payload: AuditPayload = {
  event_type: "staff.created",
  actor: { user_id: "u1", role: "super_admin", terminal_id: null },
  target: { type: "staff", id: "u2" },
  before: null,
  after: { active: true },
  detail: null,
  occurred_at: "2026-09-30T10:00:00.000000Z",
};

describe("audit chain hashing", () => {
  it("derives the genesis value from the published prefix", () => {
    expect(genesisHash(null)).toBe(sha256Hex("campus-evm/audit-genesis/v1:system"));
    expect(genesisHash("e1")).toBe(sha256Hex("campus-evm/audit-genesis/v1:e1"));
  });

  it("hashes prev_hash followed by the canonical event body", () => {
    const prev = genesisHash(null);
    const event = { election_id: null, seq: 1, prev_hash: prev, payload };
    const body =
      '{"election_id":null,"payload":{"actor":{"role":"super_admin","terminal_id":null,"user_id":"u1"},' +
      '"after":{"active":true},"before":null,"detail":null,"event_type":"staff.created",' +
      '"occurred_at":"2026-09-30T10:00:00.000000Z","target":{"id":"u2","type":"staff"}},' +
      `"prev_hash":"${prev}","seq":1}`;
    expect(computeEventHash(event)).toBe(sha256Hex(prev + body));
  });

  it("changes when any field changes", () => {
    const base = { election_id: null, seq: 1, prev_hash: genesisHash(null), payload };
    const h = computeEventHash(base);
    expect(computeEventHash({ ...base, seq: 2 })).not.toBe(h);
    expect(computeEventHash({ ...base, election_id: "e" })).not.toBe(h);
    expect(
      computeEventHash({ ...base, payload: { ...payload, after: { active: false } } }),
    ).not.toBe(h);
  });
});

describe("assertNoChoiceData", () => {
  it("accepts ordinary payloads", () => {
    expect(() => assertNoChoiceData(payload)).not.toThrow();
  });

  it.each(["candidate_id", "choices", "NOTA", "vote_selection_id"])(
    "rejects a nested %s key",
    (key) => {
      expect(() => assertNoChoiceData({ after: { items: [{ [key]: "x" }] } })).toThrow(
        "must not contain choice data",
      );
    },
  );
});
