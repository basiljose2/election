import { afterAll, describe, expect, it } from "vitest";
import { BOOTH_TRANSITIONS, ELECTION_TRANSITIONS, pairsOf } from "@/lib/lifecycle/tables";
import { adminPool } from "../support/fixtures";

const admin = adminPool();
afterAll(() => admin.end());

describe("TypeScript and SQL transition tables", () => {
  it("permit exactly the same Election (from, to) pairs", async () => {
    const { rows } = await admin.query<{ pair: string }>(
      "select from_status::text || '>' || to_status::text as pair from public.election_transitions",
    );
    expect(rows.map((r) => r.pair).sort()).toEqual(pairsOf(ELECTION_TRANSITIONS));
  });

  it("permit exactly the same booth (from, to) pairs", async () => {
    const { rows } = await admin.query<{ pair: string }>(
      "select from_state::text || '>' || to_state::text as pair from public.booth_transitions",
    );
    expect(rows.map((r) => r.pair).sort()).toEqual(pairsOf(BOOTH_TRANSITIONS));
  });

  it("use the same state names as the database enums", async () => {
    const { rows } = await admin.query<{ kind: string; label: string }>(
      `select t.typname as kind, e.enumlabel as label
         from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname in ('election_status', 'booth_state') order by e.enumsortorder`,
    );
    const labels = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.label);
    const { ELECTION_STATES, BOOTH_STATES } = await import("@/lib/lifecycle/tables");
    expect(labels("election_status").sort()).toEqual([...ELECTION_STATES].sort());
    expect(labels("booth_state")).toEqual([...BOOTH_STATES]);
  });
});
