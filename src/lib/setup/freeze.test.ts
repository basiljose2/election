import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@/lib/audit/canonical-json";
import {
  buildFrozenSetup,
  validateFreeze,
  type SetupBooth,
  type SetupCandidate,
  type SetupData,
  type SetupPost,
} from "./freeze";

const cand = (id: string, name: string, sortOrder: number): SetupCandidate => ({
  id,
  name,
  sortOrder,
  photoHash: null,
  symbolHash: null,
  symbolText: null,
});

const post = (
  id: string,
  name: string,
  seats: number,
  displayOrder: number,
  candidates: SetupCandidate[],
): SetupPost => ({ id, name, seats, displayOrder, candidates });

const booth = (id: string, name: string, postIds: string[], pos = 1): SetupBooth => ({
  id,
  name,
  location: `${name} location`,
  postIds,
  presidingOfficers: pos,
});

/** Two booths; "CS Rep" is mapped only to the CS Block; "Treasurer" is uncontested. */
function fixture(nota = true): SetupData {
  return {
    election: {
      id: "election-1",
      name: "Union 2026",
      description: "",
      pollingDate: "2026-11-05",
      notaEnabled: nota,
    },
    posts: [
      post("p-pres", "President", 1, 0, [
        cand("c-chen", "Chen", 2),
        cand("c-asha", "Asha", 0),
        cand("c-bilal", "Bilal", 1),
      ]),
      post("p-cs", "CS Rep", 1, 1, [cand("c-dev", "Dev", 0), cand("c-eli", "Eli", 1)]),
      post("p-treas", "Treasurer", 2, 2, [cand("c-fay", "Fay", 0), cand("c-gus", "Gus", 1)]),
    ],
    booths: [
      booth("b-main", "Main Hall", ["p-pres", "p-treas"]),
      booth("b-cs", "CS Block", ["p-pres", "p-cs", "p-treas"]),
    ],
  };
}

const codes = (data: SetupData) => validateFreeze(data).map((v) => v.code);

describe("validateFreeze", () => {
  it("accepts a valid setup", () => {
    expect(validateFreeze(fixture())).toEqual([]);
  });

  it("requires at least one Post", () => {
    const data = { ...fixture(), posts: [], booths: [] };
    expect(codes(data)).toEqual(["no_posts"]);
  });

  it("requires at least as many Candidates as seats, naming the Post", () => {
    const data = fixture();
    data.posts[0] = post("p-pres", "President", 3, 0, [cand("c-asha", "Asha", 0)]);
    // (Main Hall, whose only Post is now short of Candidates, is reported too.)
    const violations = validateFreeze(data).filter((v) => v.code === "too_few_candidates");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      code: "too_few_candidates",
      subject: { type: "post", id: "p-pres" },
    });
    expect(violations[0]!.message).toContain("President");
  });

  it("requires every contested Post to be mapped to a booth", () => {
    const data = fixture();
    data.booths[1]!.postIds = ["p-pres", "p-treas"]; // CS Rep now on no booth
    expect(validateFreeze(data)).toMatchObject([
      { code: "post_unmapped", subject: { id: "p-cs" } },
    ]);
  });

  it("does not require an uncontested Post to be mapped", () => {
    const data = fixture();
    data.booths.forEach((b) => (b.postIds = b.postIds.filter((id) => id !== "p-treas")));
    expect(validateFreeze(data)).toEqual([]);
  });

  it("requires every booth to be mapped to a contested Post", () => {
    const data = fixture();
    data.booths.push(booth("b-annex", "Annex", ["p-treas"])); // only an uncontested Post
    data.booths.push(booth("b-empty", "Empty", []));
    expect(validateFreeze(data).map((v) => [v.code, v.subject.id])).toEqual([
      ["booth_without_post", "b-annex"],
      ["booth_without_post", "b-empty"],
    ]);
  });

  it("requires every booth to have a Presiding Officer", () => {
    const data = fixture();
    data.booths[0]!.presidingOfficers = 0;
    expect(validateFreeze(data)).toMatchObject([
      { code: "booth_without_presiding_officer", subject: { id: "b-main" } },
    ]);
  });

  it("reports all violations at once", () => {
    const data = fixture();
    data.booths[0]!.presidingOfficers = 0; // booth without PO
    data.booths[1]!.postIds = ["p-pres"]; // CS Rep unmapped
    data.posts.push(post("p-short", "Short", 2, 3, [cand("c-x", "X", 0)]));
    expect(codes(data).sort()).toEqual(
      ["booth_without_presiding_officer", "post_unmapped", "too_few_candidates"].sort(),
    );
  });
});

describe("buildFrozenSetup", () => {
  it("detects uncontested Posts (candidates = seats) and excludes them from every Ballot Definition", () => {
    const frozen = buildFrozenSetup(fixture(), 1);
    expect(frozen.uncontestedPostIds).toEqual(["p-treas"]);
    for (const def of frozen.definitions) {
      const parsed = JSON.parse(def.canonicalJson) as { posts: Array<{ post_id: string }> };
      expect(parsed.posts.map((p) => p.post_id)).not.toContain("p-treas");
    }
  });

  it("numbers Candidates 1..k in the Returning Officer's order and puts NOTA last", () => {
    const frozen = buildFrozenSetup(fixture(true), 1);
    const main = JSON.parse(frozen.definitions.find((d) => d.boothId === "b-main")!.canonicalJson);
    expect(main.posts).toHaveLength(1);
    expect(
      main.posts[0].candidates.map((c: { serial: number; name: string }) => [c.serial, c.name]),
    ).toEqual([
      [1, "Asha"],
      [2, "Bilal"],
      [3, "Chen"],
    ]);
    expect(main.posts[0].nota_serial).toBe(4);
  });

  it("omits NOTA when it is disabled", () => {
    const frozen = buildFrozenSetup(fixture(false), 1);
    const def = JSON.parse(frozen.definitions[0]!.canonicalJson);
    expect(def.nota_enabled).toBe(false);
    expect(def.posts.every((p: { nota_serial: number | null }) => p.nota_serial === null)).toBe(
      true,
    );
  });

  it("gives each booth only its mapped Posts (two-booth fixture with a booth-specific Post)", () => {
    const frozen = buildFrozenSetup(fixture(), 1);
    const postsOf = (boothId: string) =>
      (
        JSON.parse(frozen.definitions.find((d) => d.boothId === boothId)!.canonicalJson) as {
          posts: Array<{ post_id: string; seats: number }>;
        }
      ).posts.map((p) => p.post_id);
    expect(postsOf("b-main")).toEqual(["p-pres"]);
    expect(postsOf("b-cs")).toEqual(["p-pres", "p-cs"]); // display order
    const cs = JSON.parse(frozen.definitions.find((d) => d.boothId === "b-cs")!.canonicalJson);
    expect(cs.posts[1].candidates.map((c: { name: string }) => c.name)).toEqual(["Dev", "Eli"]);
    expect(cs.posts[1].candidates.map((c: { serial: number }) => c.serial)).toEqual([1, 2]);
    expect(cs.setup_hash).toBe(frozen.setupHash);
  });

  it("produces a Setup Hash that anyone can recompute from the published canonical JSON", () => {
    const frozen = buildFrozenSetup(fixture(), 1);
    const recomputed = createHash("sha256").update(frozen.canonicalJson, "utf8").digest("hex");
    expect(frozen.setupHash).toBe(recomputed);
    // The published text is itself canonical: re-encoding the parsed JSON yields the same bytes.
    expect(canonicalJson(JSON.parse(frozen.canonicalJson))).toBe(frozen.canonicalJson);
    for (const def of frozen.definitions) {
      expect(def.hash).toBe(createHash("sha256").update(def.canonicalJson, "utf8").digest("hex"));
    }
  });

  it("is deterministic and independent of input order", () => {
    const a = buildFrozenSetup(fixture(), 1);
    const shuffled = fixture();
    shuffled.posts.reverse();
    shuffled.booths.reverse();
    shuffled.posts.forEach((p) => p.candidates.reverse());
    expect(buildFrozenSetup(shuffled, 1).setupHash).toBe(a.setupHash);
  });

  it("changes when anything in the setup changes, including the freeze generation", () => {
    const base = buildFrozenSetup(fixture(), 1).setupHash;
    expect(buildFrozenSetup(fixture(), 2).setupHash).not.toBe(base);
    const renamed = fixture();
    renamed.posts[0]!.candidates[0]!.name = "Chen K";
    expect(buildFrozenSetup(renamed, 1).setupHash).not.toBe(base);
    const swapped = fixture();
    swapped.posts[0]!.candidates[0]!.photoHash = "a".repeat(64);
    expect(buildFrozenSetup(swapped, 1).setupHash).not.toBe(base);
  });
});
