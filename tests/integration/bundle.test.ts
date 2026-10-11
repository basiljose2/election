import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import type { Actor } from "@/lib/auth/roles";
import { createBallotCommands } from "@/lib/commands/ballots";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { createAppLifecycle } from "@/lib/lifecycle/app";
import { MemorySignalBus } from "@/lib/signals/memory";
import { ensureBundle } from "@/lib/transparency/bundle";
import { castBallot, fetchPendingBallot, type CastingDeps } from "@/lib/votes/casting";
import { parseMasterKey } from "@/lib/votes/keys";
import { verifyBundle } from "../../tools/verifier/lib/bundle.mjs";
import { readZip } from "../../tools/verifier/lib/zip.mjs";
import { adminPool, appPool, setBoothState } from "../support/fixtures";
import { buildVotingWorld, validAnswers, type VotingWorld } from "../support/voting-world";

const app = appPool();
const admin = adminPool();
const bus = new MemorySignalBus();
const ballots = createBallotCommands(bus);
const lifecycle = createAppLifecycle(bus);
const masterKey = parseMasterKey(process.env.VOTE_SIGNING_MASTER_KEY);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const now = () => new Date();
const gw = (actor: Actor): Partial<GatewayDeps> => ({
  db: app,
  now,
  authenticate: async () => actor,
  appendAudit: appendAuditEvent,
});
const castingDeps: CastingDeps = {
  db: app,
  now,
  appendAudit: appendAuditEvent,
  publisher: bus,
  masterKey,
};

type Files = Map<string, Uint8Array>;
interface Check {
  id: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}
interface Report {
  ok: boolean;
  checks: Check[];
  resultHash: string;
}

async function cast(w: VotingWorld, answers: ReturnType<typeof validAnswers>) {
  await executeCommand(
    ballots.issueBallotSession,
    { boothId: w.boothId, masterToken: w.masterToken },
    gw(w.po),
  );
  const pending = await fetchPendingBallot({ db: app }, w.voting);
  if (pending.status !== "pending") throw new Error("no pending ballot");
  await castBallot(castingDeps, w.voting, {
    castToken: pending.castToken,
    idempotencyKey: randomUUID().replace(/-/g, ""),
    answers,
  });
}

/** A declared election and its stored bundle. */
async function declaredBundle() {
  const w = await buildVotingWorld(admin, { unmappedPost: true });
  for (const answers of [
    validAnswers(w, { president: 0, council: [0, 1] }),
    validAnswers(w, { president: 0, council: [0, 2] }),
    validAnswers(w, { president: 1, council: [1, 2] }),
    validAnswers(w, { president: "nota", council: [0, 1] }),
  ]) {
    await cast(w, answers);
  }
  await executeCommand(
    lifecycle.closePoll,
    { electionId: w.electionId, boothId: w.boothId },
    gw(w.po),
  );
  await setBoothState(admin, w.other!.boothId, "open");
  await executeCommand(
    lifecycle.closePoll,
    { electionId: w.electionId, boothId: w.other!.boothId },
    gw(w.other!.po),
  );
  await executeCommand(lifecycle.completePolls, { electionId: w.electionId }, gw(w.ro));
  await executeCommand(lifecycle.declareResults, { electionId: w.electionId }, gw(w.ro));

  const bundle = await ensureBundle(app, w.electionId);
  expect(bundle).not.toBeNull();
  const files: Files = await readZip(new Uint8Array(bundle!.zip));
  return { w, bundle: bundle!, files };
}

const text = (files: Files, name: string) => new TextDecoder().decode(files.get(name)!);
const put = (files: Files, name: string, value: unknown) =>
  files.set(name, new TextEncoder().encode(JSON.stringify(value, null, 2)));

/** The attacker also fixes the manifest, so only the real checks can catch the change. */
function refreshManifest(files: Files) {
  const manifest = JSON.parse(text(files, "manifest.json"));
  for (const name of Object.keys(manifest.files)) {
    manifest.files[name] = createHash("sha256").update(files.get(name)!).digest("hex");
  }
  put(files, "manifest.json", manifest);
}

const clone = (files: Files): Files => new Map(files);
const verify = (files: Files) => verifyBundle(files) as Promise<Report>;
const status = (r: Report, id: string) => r.checks.find((c) => c.id === id)!.status;
const failed = (r: Report) => r.checks.filter((c) => c.status === "fail").map((c) => c.id);

describe("the verification bundle", () => {
  it("is stored at declaration, contains everything, and links no vote to a session or time", async () => {
    const { w, bundle, files } = await declaredBundle();
    expect(bundle.bundleHash).toMatch(/^[0-9a-f]{64}$/);

    expect([...files.keys()].sort()).toEqual(
      [
        "README.md",
        "ballot-definitions.json",
        "audit.json",
        "manifest.json",
        "public-key.json",
        "result.json",
        `selections/${w.boothId}.json`,
        `selections/${w.other!.boothId}.json`,
        "setup.json",
        "tallies.json",
      ].sort(),
    );
    expect(text(files, "README.md")).toMatch(/Merkle root/);
    expect(JSON.parse(text(files, "public-key.json")).public_key).toBe(w.publicKey);

    const rows = JSON.parse(text(files, `selections/${w.boothId}.json`)) as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(12); // 4 ballots x (1 + 2) rows
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        ["candidate_id", "id", "is_nota", "post_id", "signature"].sort(),
      );
    }
    const ids = rows.map((r) => r.id as string);
    expect(ids).toEqual([...ids].sort());

    // Audit events carry no choices.
    expect(text(files, "audit.json")).not.toMatch(/"candidate_ids?"/);

    // Stored once: asking again returns the same bytes.
    const again = await ensureBundle(app, w.electionId);
    expect(again!.bundleHash).toBe(bundle.bundleHash);
  });

  it("an honest bundle passes every check and the recount equals the Result", async () => {
    const { files } = await declaredBundle();
    const report = await verify(files);
    expect(failed(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      "manifest:pass",
      "audit_chain:pass",
      "setup:pass",
      "tallies:pass",
      "vote_signatures:pass",
      "merkle:pass",
      "answer_rule:pass",
      "result:pass",
      "recount:pass",
      "winners:pass",
    ]);
  });

  it("detects an altered vote: signature and Merkle root fail for that booth", async () => {
    const { w, files } = await declaredBundle();
    const tampered = clone(files);
    const name = `selections/${w.boothId}.json`;
    const rows = JSON.parse(text(tampered, name));
    const row = rows.find((r: { is_nota: boolean }) => !r.is_nota);
    row.candidate_id = row.candidate_id === w.presidents[2] ? w.presidents[1] : w.presidents[2];
    put(tampered, name, rows);
    refreshManifest(tampered);

    const report = await verify(tampered);
    expect(status(report, "vote_signatures")).toBe("fail");
    expect(status(report, "merkle")).toBe("fail");
    expect(report.checks.find((c) => c.id === "merkle")!.detail).toContain(w.boothId);
    expect(report.ok).toBe(false);
  });

  it("detects a removed vote", async () => {
    const { w, files } = await declaredBundle();
    const tampered = clone(files);
    const name = `selections/${w.boothId}.json`;
    put(tampered, name, JSON.parse(text(tampered, name)).slice(1));
    refreshManifest(tampered);

    const report = await verify(tampered);
    expect(status(report, "merkle")).toBe("fail");
    expect(status(report, "recount")).toBe("fail");
    expect(status(report, "vote_signatures")).toBe("pass");
  });

  it("detects an extra vote", async () => {
    const { w, files } = await declaredBundle();
    const tampered = clone(files);
    const name = `selections/${w.boothId}.json`;
    const rows = JSON.parse(text(tampered, name));
    rows.push({ ...rows[0], id: randomUUID() }); // a copied signature on a new row
    put(tampered, name, rows);
    refreshManifest(tampered);

    const report = await verify(tampered);
    expect(status(report, "vote_signatures")).toBe("fail");
    expect(status(report, "merkle")).toBe("fail");
  });

  it("detects an altered audit event", async () => {
    const { files } = await declaredBundle();
    const tampered = clone(files);
    const audit = JSON.parse(text(tampered, "audit.json"));
    audit.events[2].payload.detail = { tampered: true };
    put(tampered, "audit.json", audit);
    refreshManifest(tampered);

    const report = await verify(tampered);
    expect(status(report, "audit_chain")).toBe("fail");
    expect(report.checks.find((c) => c.id === "audit_chain")!.detail).toContain("event 3");
  });

  it("detects an altered Result, even if its hash is recomputed", async () => {
    const { files } = await declaredBundle();
    const tampered = clone(files);
    const result = JSON.parse(text(tampered, "result.json"));
    const doc = JSON.parse(result.canonical_json);
    const post = doc.posts.find((p: { status: string }) => p.status === "elected");
    post.candidates[0].votes += 5;
    result.canonical_json = JSON.stringify(doc);
    result.result_hash = createHash("sha256").update(result.canonical_json).digest("hex");
    put(tampered, "result.json", result);
    refreshManifest(tampered);

    const report = await verify(tampered);
    expect(status(report, "result")).toBe("fail"); // the signature no longer fits
    expect(status(report, "recount")).toBe("fail");
  });

  it("detects a changed winner in an otherwise consistent Result", async () => {
    const { files } = await declaredBundle();
    const tampered = clone(files);
    const result = JSON.parse(text(tampered, "result.json"));
    const doc = JSON.parse(result.canonical_json);
    const post = doc.posts.find((p: { status: string }) => p.status === "elected");
    // The loser is declared Elected: counts untouched, outcome flipped.
    post.candidates[post.candidates.length - 1].outcome = "elected";
    result.canonical_json = JSON.stringify(doc);
    result.result_hash = createHash("sha256").update(result.canonical_json).digest("hex");
    put(tampered, "result.json", result);
    refreshManifest(tampered);

    const report = await verify(tampered);
    expect(status(report, "winners")).toBe("fail");
  });

  it("the command-line verifier gives the same report as the module", async () => {
    const { bundle, files } = await declaredBundle();
    const dir = mkdtempSync(path.join(tmpdir(), "bundle-"));
    const file = path.join(dir, "bundle.zip");
    writeFileSync(file, bundle.zip);

    const cli = JSON.parse(
      execFileSync("node", ["tools/verifier/verify-bundle.mjs", file, "--json"], {
        encoding: "utf8",
      }),
    ) as Report;
    const inProcess = await verify(files);
    expect(cli.checks.map((c) => `${c.id}:${c.status}`)).toEqual(
      inProcess.checks.map((c) => `${c.id}:${c.status}`),
    );
    expect(cli.resultHash).toBe(inProcess.resultHash);

    // And it exits non-zero on a damaged bundle.
    const damaged = Buffer.from(bundle.zip);
    damaged[100] = damaged[100]! ^ 0xff;
    writeFileSync(path.join(dir, "damaged.zip"), damaged);
    expect(() =>
      execFileSync("node", ["tools/verifier/verify-bundle.mjs", path.join(dir, "damaged.zip")], {
        stdio: "pipe",
      }),
    ).toThrow();
  });
});
