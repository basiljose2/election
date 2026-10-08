import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import { canonicalJson } from "@/lib/audit/canonical-json";
import { buildAuditExport, serializeAuditExport, type AuditExport } from "@/lib/audit/export";
import { withTransaction } from "@/lib/db/pool";
import * as verifier from "../../tools/verifier/verify-audit.mjs";
import { appPool } from "../support/fixtures";

const app = appPool();
afterAll(() => app.end());

const verifierPath = path.resolve(__dirname, "../../tools/verifier/verify-audit.mjs");
const clone = (doc: AuditExport): AuditExport => JSON.parse(JSON.stringify(doc));

function runCli(doc: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), "audit-"));
  const file = path.join(dir, "export.json");
  writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
  return spawnSync(process.execPath, [verifierPath, file], { encoding: "utf8" });
}

describe("standalone audit verifier", () => {
  const electionId = randomUUID();
  let doc: AuditExport;

  beforeAll(async () => {
    for (let i = 0; i < 6; i++) {
      await withTransaction(app, (tx) =>
        appendAuditEvent(tx, {
          electionId,
          eventType: "test.event",
          actor: { user_id: null, role: "system", terminal_id: null },
          target: { type: "election", id: electionId },
          after: { i, note: `événement ${i} ☃` },
        }),
      );
    }
    doc = await buildAuditExport(app, electionId);
  });

  it("imports no application code", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(verifierPath, "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports.every((m) => m!.startsWith("node:"))).toBe(true);
  });

  it("agrees with the application's canonical JSON", () => {
    const samples = [doc.events[0]!.payload, { b: [1, { d: null, c: "é" }], a: true, B: -0 }];
    for (const sample of samples) {
      expect(verifier.canonicalJson(sample)).toBe(canonicalJson(sample));
    }
  });

  it("accepts an unmodified export", () => {
    expect(verifier.verifyAuditExport(doc)).toMatchObject({ ok: true, count: 6 });
    const cli = runCli(serializeAuditExport(doc));
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("OK");
  });

  it("detects an altered event", () => {
    const altered = clone(doc);
    (altered.events[2]!.payload.after as { i: number }).i = 99;
    expect(verifier.verifyAuditExport(altered)).toMatchObject({ ok: false, seq: 3 });

    const cli = runCli(altered);
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("first mismatch at seq 3");
  });

  it("detects an altered event whose hash was recomputed", () => {
    const altered = clone(doc);
    const event = altered.events[2]!;
    event.payload.event_type = "test.forged";
    event.hash = verifier.eventHash(event);
    expect(verifier.verifyAuditExport(altered)).toMatchObject({ ok: false, seq: 4 });
  });

  it("detects a removed event", () => {
    const removed = clone(doc);
    removed.events.splice(3, 1);
    expect(verifier.verifyAuditExport(removed)).toMatchObject({ ok: false, seq: 4 });

    const cli = runCli(removed);
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("first mismatch at seq 4");
  });

  it("detects a removed event even when the survivors are renumbered", () => {
    const removed = clone(doc);
    removed.events.splice(1, 1);
    removed.events.forEach((e, i) => (e.seq = i + 1));
    expect(verifier.verifyAuditExport(removed)).toMatchObject({ ok: false, seq: 2 });
  });

  it("detects reordered events", () => {
    const reordered = clone(doc);
    [reordered.events[1], reordered.events[4]] = [reordered.events[4]!, reordered.events[1]!];
    expect(verifier.verifyAuditExport(reordered)).toMatchObject({ ok: false, seq: 2 });

    const cli = runCli(reordered);
    expect(cli.status).toBe(1);
    expect(cli.stdout).toContain("first mismatch at seq 2");
  });

  it("detects a removed final event through head_hash and event_count", () => {
    const truncated = clone(doc);
    truncated.events.pop();
    expect(verifier.verifyAuditExport(truncated).ok).toBe(false);
  });

  it("rejects a chain moved to another election", () => {
    const moved = clone(doc);
    moved.election_id = randomUUID();
    delete (moved as Partial<AuditExport>).genesis;
    expect(verifier.verifyAuditExport(moved)).toMatchObject({ ok: false, seq: 1 });
  });
});
