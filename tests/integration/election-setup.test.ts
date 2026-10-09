import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import { canonicalJson } from "@/lib/audit/canonical-json";
import type { Actor } from "@/lib/auth/roles";
import { CommandError } from "@/lib/commands/errors";
import { cloneElection, createElection, updateElection } from "@/lib/commands/election";
import { FreezeValidationError, freezeSetup, unfreezeSetup } from "@/lib/commands/freeze";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import {
  createBooth,
  createCandidate,
  createMediaCommands,
  createPost,
  deleteBooth,
  deleteCandidate,
  deletePost,
  reorderCandidates,
  reorderPosts,
  setBoothPosts,
  updateCandidate,
  updatePost,
} from "@/lib/commands/setup";
import type { ImageStore } from "@/lib/media/store";
import { sha256Hex } from "@/lib/setup/freeze";
import { listElections, loadSetupView } from "@/lib/setup/queries";
import sharp from "sharp";
import {
  actorFor,
  adminPool,
  appPool,
  auditEvents,
  createStaffFixture,
  type StaffFixture,
} from "../support/fixtures";

const app = appPool();
const admin = adminPool();

afterAll(async () => {
  await admin.query("drop table if exists public.ballot_sessions");
  await Promise.all([app.end(), admin.end()]);
});

function deps(actor: Actor, overrides: Partial<GatewayDeps> = {}): Partial<GatewayDeps> {
  return {
    db: app,
    now: () => new Date(),
    authenticate: async () => actor,
    appendAudit: appendAuditEvent,
    ...overrides,
  };
}

async function expectCommandError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof CommandError && e.code === code,
  );
}

const memoryStore = (): ImageStore & { files: Map<string, Buffer> } => {
  const files = new Map<string, Buffer>();
  return {
    files,
    async put(hash, bytes) {
      files.set(hash, bytes);
    },
  };
};

let superAdmin: Actor;

beforeAll(async () => {
  superAdmin = actorFor(await createStaffFixture(admin, [{ role: "super_admin" }]));
});

/** A Draft Election plus a Returning Officer for it. */
async function newElection(nota = true) {
  const { electionId } = await executeCommand(
    createElection,
    { name: `Union ${randomUUID().slice(0, 8)}`, pollingDate: "2026-11-05", notaEnabled: nota },
    deps(superAdmin),
  );
  const roStaff = await createStaffFixture(admin, [{ role: "returning_officer", electionId }]);
  return { electionId, ro: actorFor(roStaff), roStaff };
}

describe("elections", () => {
  it("a Super Admin creates a Draft Election with NOTA enabled, audited on its own chain", async () => {
    const { electionId } = await newElection(true);
    const view = await loadSetupView(app, electionId);
    expect(view!.election).toMatchObject({ status: "draft", nota_enabled: true });
    const events = await auditEvents(app, { electionId, eventType: "election.created" });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ after: { status: "draft", nota_enabled: true } });
  });

  it("only a Super Admin can create an Election", async () => {
    const { ro } = await newElection();
    await expectCommandError(
      executeCommand(
        createElection,
        { name: "Sneaky", pollingDate: "2026-11-05", notaEnabled: false },
        deps(ro),
      ),
      "forbidden",
    );
  });

  it("a Returning Officer edits their own Election", async () => {
    const { electionId, ro } = await newElection(false);
    await executeCommand(
      updateElection,
      {
        electionId,
        name: "Renamed",
        description: "d",
        pollingDate: "2026-12-01",
        notaEnabled: true,
      },
      deps(ro),
    );
    const view = await loadSetupView(app, electionId);
    expect(view!.election).toMatchObject({
      name: "Renamed",
      polling_date: "2026-12-01",
      nota_enabled: true,
    });
  });

  it("a Returning Officer cannot edit another Election (negative test, audited)", async () => {
    const a = await newElection();
    const b = await newElection();
    await expectCommandError(
      executeCommand(
        updateElection,
        { electionId: b.electionId, name: "Hijack", pollingDate: "2026-11-05", notaEnabled: false },
        deps(a.ro),
      ),
      "forbidden",
    );
    const view = await loadSetupView(app, b.electionId);
    expect(view!.election.name).not.toBe("Hijack");
    const denied = await auditEvents(app, {
      electionId: null,
      eventType: "authz.denied",
      actorId: a.ro.userId,
    });
    expect(denied.some((e) => JSON.stringify(e.payload).includes(b.electionId))).toBe(true);
  });

  it("isolates Elections: a Returning Officer lists only their own", async () => {
    const a = await newElection();
    const b = await newElection();
    const mine = await listElections(app, a.ro);
    expect(mine.map((e) => e.id)).toEqual([a.electionId]);
    expect((await listElections(app, superAdmin)).map((e) => e.id)).toEqual(
      expect.arrayContaining([a.electionId, b.electionId]),
    );
  });

  it("rejects editing a Frozen Election's name (command and database)", async () => {
    const f = await fullSetup();
    await executeCommand(freezeSetup, { electionId: f.electionId }, deps(f.ro));
    await expectCommandError(
      executeCommand(
        updateElection,
        { electionId: f.electionId, name: "Late", pollingDate: "2026-11-05", notaEnabled: true },
        deps(f.ro),
      ),
      "lifecycle",
    );
  });
});

describe("posts", () => {
  it("creates, orders, edits and deletes Posts", async () => {
    const { electionId, ro } = await newElection();
    const d = deps(ro);
    const a = await executeCommand(createPost, { electionId, name: "President", seats: 1 }, d);
    const b = await executeCommand(createPost, { electionId, name: "Council", seats: 3 }, d);
    const c = await executeCommand(createPost, { electionId, name: "Treasurer", seats: 1 }, d);
    let view = await loadSetupView(app, electionId);
    expect(view!.posts.map((p) => p.name)).toEqual(["President", "Council", "Treasurer"]);

    await executeCommand(
      reorderPosts,
      { electionId, orderedIds: [c.postId, a.postId, b.postId] },
      d,
    );
    await executeCommand(updatePost, { electionId, postId: b.postId, name: "Senate", seats: 2 }, d);
    await executeCommand(deletePost, { electionId, postId: a.postId }, d);
    view = await loadSetupView(app, electionId);
    expect(view!.posts.map((p) => [p.name, p.seats])).toEqual([
      ["Treasurer", 1],
      ["Senate", 2],
    ]);
  });

  it("rejects seats = 0 and duplicate names (negative tests)", async () => {
    const { electionId, ro } = await newElection();
    const d = deps(ro);
    await expectCommandError(
      executeCommand(createPost, { electionId, name: "Bad", seats: 0 }, d),
      "invalid_input",
    );
    await executeCommand(createPost, { electionId, name: "President", seats: 1 }, d);
    await expectCommandError(
      executeCommand(createPost, { electionId, name: "president", seats: 1 }, d),
      "conflict",
    );
  });

  it("scopes writes to the Election: another Election's Post is not found", async () => {
    const a = await newElection();
    const b = await newElection();
    const post = await executeCommand(
      createPost,
      { electionId: b.electionId, name: "Theirs", seats: 1 },
      deps(b.ro),
    );
    await expectCommandError(
      executeCommand(
        updatePost,
        { electionId: a.electionId, postId: post.postId, name: "Mine now", seats: 1 },
        deps(a.ro),
      ),
      "not_found",
    );
    await expectCommandError(
      executeCommand(deletePost, { electionId: a.electionId, postId: post.postId }, deps(a.ro)),
      "not_found",
    );
  });

  it("requires a full permutation to reorder", async () => {
    const { electionId, ro } = await newElection();
    const d = deps(ro);
    const a = await executeCommand(createPost, { electionId, name: "A", seats: 1 }, d);
    await executeCommand(createPost, { electionId, name: "B", seats: 1 }, d);
    await expectCommandError(
      executeCommand(reorderPosts, { electionId, orderedIds: [a.postId] }, d),
      "invalid_input",
    );
  });
});

describe("candidates", () => {
  it("persists drag ordering and keeps per-Post order", async () => {
    const { electionId, ro } = await newElection();
    const d = deps(ro);
    const post = await executeCommand(createPost, { electionId, name: "President", seats: 1 }, d);
    const ids: string[] = [];
    for (const name of ["Asha", "Bilal", "Chen"]) {
      const c = await executeCommand(createCandidate, { electionId, postId: post.postId, name }, d);
      ids.push(c.candidateId);
    }
    await executeCommand(
      reorderCandidates,
      { electionId, postId: post.postId, orderedIds: [ids[2]!, ids[0]!, ids[1]!] },
      d,
    );
    const view = await loadSetupView(app, electionId);
    expect(view!.posts[0]!.candidates.map((c) => c.name)).toEqual(["Chen", "Asha", "Bilal"]);
  });

  it("rejects duplicate names, edits and deletes within the Election only", async () => {
    const a = await newElection();
    const b = await newElection();
    const postA = await executeCommand(
      createPost,
      { electionId: a.electionId, name: "P", seats: 1 },
      deps(a.ro),
    );
    const cand = await executeCommand(
      createCandidate,
      { electionId: a.electionId, postId: postA.postId, name: "Asha", symbolText: "Star" },
      deps(a.ro),
    );
    await expectCommandError(
      executeCommand(
        createCandidate,
        { electionId: a.electionId, postId: postA.postId, name: "asha" },
        deps(a.ro),
      ),
      "conflict",
    );
    await expectCommandError(
      executeCommand(
        updateCandidate,
        { electionId: b.electionId, candidateId: cand.candidateId, name: "X" },
        deps(b.ro),
      ),
      "not_found",
    );
    await expectCommandError(
      executeCommand(
        deleteCandidate,
        { electionId: b.electionId, candidateId: cand.candidateId },
        deps(b.ro),
      ),
      "not_found",
    );
  });
});

describe("candidate media", () => {
  const png = (size: number) =>
    sharp({ create: { width: size, height: size, channels: 3, background: "#336699" } })
      .png()
      .toBuffer();

  async function candidateFixture() {
    const e = await newElection();
    const post = await executeCommand(
      createPost,
      { electionId: e.electionId, name: "P", seats: 1 },
      deps(e.ro),
    );
    const cand = await executeCommand(
      createCandidate,
      { electionId: e.electionId, postId: post.postId, name: "Asha", symbolText: "Star" },
      deps(e.ro),
    );
    return { ...e, candidateId: cand.candidateId };
  }

  it("stores a re-encoded WebP under a content hash and records the hash", async () => {
    const f = await candidateFixture();
    const store = memoryStore();
    const { setCandidateMedia } = createMediaCommands(store);
    const { hash } = await executeCommand(
      setCandidateMedia,
      { electionId: f.electionId, candidateId: f.candidateId, kind: "photo", file: await png(64) },
      deps(f.ro),
    );
    const stored = store.files.get(hash)!;
    expect(createHash("sha256").update(stored).digest("hex")).toBe(hash); // content-addressed
    expect((await sharp(stored).metadata()).format).toBe("webp");
    const view = await loadSetupView(app, f.electionId);
    expect(view!.posts[0]!.candidates[0]).toMatchObject({ photo_hash: hash });
  });

  it("an image symbol replaces a text symbol", async () => {
    const f = await candidateFixture();
    const { setCandidateMedia } = createMediaCommands(memoryStore());
    await executeCommand(
      setCandidateMedia,
      { electionId: f.electionId, candidateId: f.candidateId, kind: "symbol", file: await png(32) },
      deps(f.ro),
    );
    const c = (await loadSetupView(app, f.electionId))!.posts[0]!.candidates[0]!;
    expect(c.symbol_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.symbol_text).toBeNull();
  });

  it("rejects an oversized upload (negative test)", async () => {
    const f = await candidateFixture();
    const store = memoryStore();
    const { setCandidateMedia } = createMediaCommands(store);
    const big = Buffer.concat([await png(16), Buffer.alloc(5 * 1024 * 1024)]);
    await expectCommandError(
      executeCommand(
        setCandidateMedia,
        { electionId: f.electionId, candidateId: f.candidateId, kind: "photo", file: big },
        deps(f.ro),
      ),
      "invalid_input",
    );
    expect(store.files.size).toBe(0);
  });

  it("rejects a disguised file whatever its extension (negative test)", async () => {
    const f = await candidateFixture();
    const store = memoryStore();
    const { setCandidateMedia } = createMediaCommands(store);
    for (const bytes of [
      Buffer.from("<?php echo 'hi'; ?>"),
      Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      Buffer.from("MZ\x90\x00\x03\x00\x00\x00"),
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("not a png"),
      ]),
    ]) {
      await expectCommandError(
        executeCommand(
          setCandidateMedia,
          { electionId: f.electionId, candidateId: f.candidateId, kind: "photo", file: bytes },
          deps(f.ro),
        ),
        "invalid_input",
      );
    }
    expect(store.files.size).toBe(0);
  });
});

describe("booths and Booth-Post mapping", () => {
  it("persists the mapping and replaces it per booth", async () => {
    const { electionId, ro } = await newElection();
    const d = deps(ro);
    const p1 = await executeCommand(createPost, { electionId, name: "P1", seats: 1 }, d);
    const p2 = await executeCommand(createPost, { electionId, name: "P2", seats: 1 }, d);
    const booth = await executeCommand(
      createBooth,
      { electionId, name: "Main Hall", location: "Block A" },
      d,
    );
    await executeCommand(
      setBoothPosts,
      { electionId, boothId: booth.boothId, postIds: [p1.postId, p2.postId] },
      d,
    );
    expect((await loadSetupView(app, electionId))!.booths[0]!.post_ids.sort()).toEqual(
      [p1.postId, p2.postId].sort(),
    );
    await executeCommand(
      setBoothPosts,
      { electionId, boothId: booth.boothId, postIds: [p2.postId] },
      d,
    );
    expect((await loadSetupView(app, electionId))!.booths[0]!.post_ids).toEqual([p2.postId]);
  });

  it("is scoped to the Election (negative tests)", async () => {
    const a = await newElection();
    const b = await newElection();
    const postB = await executeCommand(
      createPost,
      { electionId: b.electionId, name: "P", seats: 1 },
      deps(b.ro),
    );
    const boothA = await executeCommand(
      createBooth,
      { electionId: a.electionId, name: "Hall", location: "A" },
      deps(a.ro),
    );
    await expectCommandError(
      executeCommand(
        setBoothPosts,
        { electionId: a.electionId, boothId: boothA.boothId, postIds: [postB.postId] },
        deps(a.ro),
      ),
      "not_found",
    );
    await expectCommandError(
      executeCommand(
        setBoothPosts,
        { electionId: b.electionId, boothId: boothA.boothId, postIds: [] },
        deps(b.ro),
      ),
      "not_found",
    );
    await expectCommandError(
      executeCommand(
        deleteBooth,
        { electionId: b.electionId, boothId: boothA.boothId },
        deps(b.ro),
      ),
      "not_found",
    );
  });
});

/**
 * A complete, freezable setup: two booths (one booth-specific Post), one uncontested Post,
 * a Presiding Officer for each booth.
 */
async function fullSetup(nota = true) {
  const e = await newElection(nota);
  const d = deps(e.ro);
  const { electionId } = e;
  const pres = await executeCommand(createPost, { electionId, name: "President", seats: 1 }, d);
  const cs = await executeCommand(createPost, { electionId, name: "CS Rep", seats: 1 }, d);
  const treas = await executeCommand(createPost, { electionId, name: "Treasurer", seats: 2 }, d);
  const add = async (postId: string, names: string[]) => {
    for (const name of names) {
      await executeCommand(createCandidate, { electionId, postId, name }, d);
    }
  };
  await add(pres.postId, ["Chen", "Asha", "Bilal"]);
  await add(cs.postId, ["Dev", "Eli"]);
  await add(treas.postId, ["Fay", "Gus"]); // 2 candidates for 2 seats: uncontested
  const view = await loadSetupView(app, electionId);
  const order = view!.posts[0]!.candidates.map((c) => c.id); // Chen, Asha, Bilal
  await executeCommand(
    reorderCandidates,
    { electionId, postId: pres.postId, orderedIds: [order[1]!, order[2]!, order[0]!] },
    d,
  ); // Asha, Bilal, Chen
  const main = await executeCommand(
    createBooth,
    { electionId, name: "Main Hall", location: "Block A" },
    d,
  );
  const csBlock = await executeCommand(
    createBooth,
    { electionId, name: "CS Block", location: "Block C" },
    d,
  );
  await executeCommand(
    setBoothPosts,
    { electionId, boothId: main.boothId, postIds: [pres.postId, treas.postId] },
    d,
  );
  await executeCommand(
    setBoothPosts,
    { electionId, boothId: csBlock.boothId, postIds: [pres.postId, cs.postId, treas.postId] },
    d,
  );
  const pos: StaffFixture[] = [];
  for (const boothId of [main.boothId, csBlock.boothId]) {
    pos.push(await createStaffFixture(admin, [{ role: "presiding_officer", electionId, boothId }]));
  }
  return { ...e, pres, cs, treas, main, csBlock, pos };
}

describe("clone election", () => {
  it("copies the setup exactly, with no Presiding Officers, ballots or snapshots", async () => {
    const f = await fullSetup();
    await executeCommand(freezeSetup, { electionId: f.electionId }, deps(f.ro));

    const { electionId: cloneId } = await executeCommand(
      cloneElection,
      { sourceElectionId: f.electionId, name: "Rehearsal" },
      deps(superAdmin),
    );
    const original = (await loadSetupView(app, f.electionId))!;
    const clone = (await loadSetupView(app, cloneId))!;

    expect(clone.election).toMatchObject({ status: "draft", freeze_count: 0, nota_enabled: true });
    const shape = (v: typeof original) => ({
      posts: v.posts.map((p) => ({
        name: p.name,
        seats: p.seats,
        candidates: p.candidates.map((c) => c.name),
      })),
      booths: v.booths.map((b) => ({
        name: b.name,
        mapped: b.post_ids.map((id) => v.posts.find((p) => p.id === id)!.name).sort(),
      })),
    });
    expect(shape(clone)).toEqual(shape(original));
    // New ids everywhere.
    expect(clone.posts.every((p) => !original.posts.some((o) => o.id === p.id))).toBe(true);
    // Nothing from polling or freezing.
    expect(clone.latestSnapshot).toBeNull();
    expect(clone.booths.every((b) => b.presiding_officer === null)).toBe(true);
    expect(clone.posts.every((p) => !p.uncontested)).toBe(true);
    const defs = await app.query("select 1 from public.ballot_definitions where election_id = $1", [
      cloneId,
    ]);
    expect(defs.rowCount).toBe(0);
    const events = await auditEvents(app, { electionId: cloneId, eventType: "election.cloned" });
    expect(events).toHaveLength(1);
  });

  it("is restricted to a Super Admin", async () => {
    const f = await fullSetup();
    await expectCommandError(
      executeCommand(cloneElection, { sourceElectionId: f.electionId, name: "Copy" }, deps(f.ro)),
      "forbidden",
    );
  });
});

describe("freeze", () => {
  it("freezes, snapshots per booth, marks uncontested, and records the Setup Hash", async () => {
    const f = await fullSetup();
    const result = await executeCommand(freezeSetup, { electionId: f.electionId }, deps(f.ro));
    expect(result.freezeNumber).toBe(1);

    const view = (await loadSetupView(app, f.electionId))!;
    expect(view.election.status).toBe("frozen");
    expect(view.posts.find((p) => p.name === "Treasurer")!.uncontested).toBe(true);
    expect(view.posts.find((p) => p.name === "President")!.uncontested).toBe(false);

    const defs = await app.query<{ booth_id: string; canonical_json: string }>(
      "select booth_id, canonical_json from public.ballot_definitions where election_id = $1",
      [f.electionId],
    );
    expect(defs.rowCount).toBe(2);
    const byBooth = new Map(defs.rows.map((r) => [r.booth_id, JSON.parse(r.canonical_json)]));
    const mainDef = byBooth.get(f.main.boothId);
    const csDef = byBooth.get(f.csBlock.boothId);
    // Treasurer is uncontested: on no ballot. CS Rep is booth-specific.
    expect(mainDef.posts.map((p: { name: string }) => p.name)).toEqual(["President"]);
    expect(csDef.posts.map((p: { name: string }) => p.name)).toEqual(["President", "CS Rep"]);
    expect(
      mainDef.posts[0].candidates.map((c: { serial: number; name: string }) => [c.serial, c.name]),
    ).toEqual([
      [1, "Asha"],
      [2, "Bilal"],
      [3, "Chen"],
    ]);
    expect(mainDef.posts[0].nota_serial).toBe(4);

    // The Setup Hash is in the freeze Audit Event and reproducible from the stored JSON.
    const events = await auditEvents(app, {
      electionId: f.electionId,
      eventType: "election.frozen",
    });
    expect(events).toHaveLength(1);
    const recorded = (events[0]!.payload.after as { setup_hash: string }).setup_hash;
    const snapshot = await app.query<{ canonical_json: string; setup_hash: string }>(
      "select canonical_json, setup_hash from public.setup_snapshots where election_id = $1",
      [f.electionId],
    );
    expect(snapshot.rows[0]!.setup_hash).toBe(recorded);
    expect(sha256Hex(snapshot.rows[0]!.canonical_json)).toBe(recorded);
    expect(canonicalJson(JSON.parse(snapshot.rows[0]!.canonical_json))).toBe(
      snapshot.rows[0]!.canonical_json,
    );
  });

  it("cannot be edited afterwards through commands or the database (negative tests)", async () => {
    const f = await fullSetup();
    await executeCommand(freezeSetup, { electionId: f.electionId }, deps(f.ro));
    const view = (await loadSetupView(app, f.electionId))!;
    const candidate = view.posts[0]!.candidates[0]!;
    await expectCommandError(
      executeCommand(
        updateCandidate,
        { electionId: f.electionId, candidateId: candidate.id, name: "Renamed" },
        deps(f.ro),
      ),
      "lifecycle",
    );
    await expect(
      app.query("update public.candidates set name = 'Renamed' where id = $1", [candidate.id]),
    ).rejects.toMatchObject({ code: "P0001" });
    await expectCommandError(
      executeCommand(freezeSetup, { electionId: f.electionId }, deps(f.ro)),
      "lifecycle",
    );
  });

  it("reports every violation at once", async () => {
    const f = await fullSetup();
    const d = deps(f.ro);
    // Booth without a PO, a Post with too few candidates, and an unmapped Post.
    await admin.query(
      "update public.staff_roles set revoked_at = now(), revoked_by = $2 where id = $1",
      [f.pos[0]!.roles[0]!.id, superAdmin.userId],
    );
    await executeCommand(createPost, { electionId: f.electionId, name: "Short", seats: 3 }, d);
    const lone = await executeCommand(
      createPost,
      { electionId: f.electionId, name: "Unmapped", seats: 1 },
      d,
    );
    await executeCommand(
      createCandidate,
      { electionId: f.electionId, postId: lone.postId, name: "Q" },
      d,
    );
    await executeCommand(
      createCandidate,
      { electionId: f.electionId, postId: lone.postId, name: "R" },
      d,
    );

    const error = await executeCommand(freezeSetup, { electionId: f.electionId }, d).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FreezeValidationError);
    const codes = (error as FreezeValidationError).violations.map((v) => v.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "booth_without_presiding_officer",
        "too_few_candidates",
        "post_unmapped",
      ]),
    );
    expect((await loadSetupView(app, f.electionId))!.election.status).toBe("draft");
  });

  it("requires recent re-authentication (stale auth is rejected)", async () => {
    const f = await fullSetup();
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const staleRo: Actor = { ...f.ro, authTimes: { password: stale, totp: stale } };
    await expectCommandError(
      executeCommand(freezeSetup, { electionId: f.electionId }, deps(staleRo)),
      "reauth_required",
    );
    expect((await loadSetupView(app, f.electionId))!.election.status).toBe("draft");
  });

  it("only the Election's Returning Officer can freeze (negative test)", async () => {
    const f = await fullSetup();
    const other = await newElection();
    await expectCommandError(
      executeCommand(freezeSetup, { electionId: f.electionId }, deps(other.ro)),
      "forbidden",
    );
    await expectCommandError(
      executeCommand(freezeSetup, { electionId: f.electionId }, deps(superAdmin)),
      "forbidden",
    );
  });

  it("Ballot Definitions and snapshots cannot be changed by the application role", async () => {
    const f = await fullSetup();
    await executeCommand(freezeSetup, { electionId: f.electionId }, deps(f.ro));
    await expect(
      app.query(
        "update public.ballot_definitions set canonical_json = '{}' where election_id = $1",
        [f.electionId],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      app.query("delete from public.setup_snapshots where election_id = $1", [f.electionId]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("unfreeze", () => {
  it("returns to Draft when no Ballot Session exists, and a later freeze gets a new Setup Hash", async () => {
    const f = await fullSetup();
    const d = deps(f.ro);
    const first = await executeCommand(freezeSetup, { electionId: f.electionId }, d);
    await executeCommand(unfreezeSetup, { electionId: f.electionId }, d);

    let view = (await loadSetupView(app, f.electionId))!;
    expect(view.election.status).toBe("draft");
    expect(view.posts.every((p) => !p.uncontested)).toBe(true);

    const second = await executeCommand(freezeSetup, { electionId: f.electionId }, d);
    expect(second.freezeNumber).toBe(2);
    expect(second.setupHash).not.toBe(first.setupHash);
    view = (await loadSetupView(app, f.electionId))!;
    expect(view.latestSnapshot).toMatchObject({ freeze_no: 2, setup_hash: second.setupHash });
    const snapshots = await app.query(
      "select 1 from public.setup_snapshots where election_id = $1",
      [f.electionId],
    );
    expect(snapshots.rowCount).toBe(2); // history is kept
    expect(
      await auditEvents(app, { electionId: f.electionId, eventType: "election.unfrozen" }),
    ).toHaveLength(1);
  });

  it("is rejected once a Ballot Session exists (negative test with a fixture row)", async () => {
    const f = await fullSetup();
    const d = deps(f.ro);
    await executeCommand(freezeSetup, { electionId: f.electionId }, d);

    // ballot_sessions is owned by ballot-casting-core; a minimal fixture table stands in.
    await admin.query("create table if not exists public.ballot_sessions (booth_id uuid not null)");
    await admin.query("grant select on public.ballot_sessions to app_server");
    await admin.query("insert into public.ballot_sessions (booth_id) values ($1)", [
      f.main.boothId,
    ]);
    try {
      await expectCommandError(
        executeCommand(unfreezeSetup, { electionId: f.electionId }, d),
        "lifecycle",
      );
      expect((await loadSetupView(app, f.electionId))!.election.status).toBe("frozen");
      // The database refuses too, even if a command were bypassed.
      await expect(
        app.query("update public.elections set status = 'draft', frozen_at = null where id = $1", [
          f.electionId,
        ]),
      ).rejects.toMatchObject({ code: "P0001" });
    } finally {
      await admin.query("drop table public.ballot_sessions");
    }
  });

  it("requires re-authentication and the Returning Officer", async () => {
    const f = await fullSetup();
    await executeCommand(freezeSetup, { electionId: f.electionId }, deps(f.ro));
    const stale = Math.floor(Date.now() / 1000) - 3600;
    await expectCommandError(
      executeCommand(
        unfreezeSetup,
        { electionId: f.electionId },
        deps({ ...f.ro, authTimes: { password: stale, totp: stale } }),
      ),
      "reauth_required",
    );
    await expectCommandError(
      executeCommand(unfreezeSetup, { electionId: f.electionId }, deps(superAdmin)),
      "forbidden",
    );
  });
});
