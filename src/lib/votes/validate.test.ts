import { describe, expect, it } from "vitest";
import { validateBallot, type BallotDefinitionView } from "./validate";

const definition = (notaEnabled: boolean): BallotDefinitionView => ({
  nota_enabled: notaEnabled,
  posts: [
    { post_id: "pres", seats: 1, candidates: [{ id: "asha" }, { id: "bilal" }, { id: "chen" }] },
    {
      post_id: "council",
      seats: 3,
      candidates: [{ id: "dev" }, { id: "eli" }, { id: "fay" }, { id: "gus" }],
    },
  ],
});

const ok = { postId: "pres", candidateIds: ["asha"] };
const council3 = { postId: "council", candidateIds: ["dev", "eli", "fay"] };

interface Case {
  name: string;
  nota?: boolean;
  answers: unknown;
  expect: "valid" | string[]; // issue codes, in order
}

const CASES: Case[] = [
  { name: "single-seat post: one Candidate", answers: [ok, council3], expect: "valid" },
  {
    name: "multi-seat post: exactly N distinct Candidates",
    answers: [ok, { postId: "council", candidateIds: ["gus", "dev", "eli"] }],
    expect: "valid",
  },
  {
    name: "multi-seat post, too few (2 of 3)",
    answers: [ok, { postId: "council", candidateIds: ["dev", "eli"] }],
    expect: ["wrong_count"],
  },
  {
    name: "multi-seat post, too many (4 of 3)",
    answers: [ok, { postId: "council", candidateIds: ["dev", "eli", "fay", "gus"] }],
    expect: ["wrong_count"],
  },
  {
    name: "single-seat post, two Candidates",
    answers: [{ postId: "pres", candidateIds: ["asha", "bilal"] }, council3],
    expect: ["wrong_count"],
  },
  {
    name: "duplicate Candidate",
    answers: [ok, { postId: "council", candidateIds: ["dev", "dev", "eli"] }],
    expect: ["duplicate_candidate"],
  },
  {
    name: "Candidate of another Post",
    answers: [{ postId: "pres", candidateIds: ["dev"] }, council3],
    expect: ["unknown_candidate"],
  },
  {
    name: "unknown Candidate id",
    answers: [{ postId: "pres", candidateIds: ["nobody"] }, council3],
    expect: ["unknown_candidate"],
  },
  {
    name: "NOTA alone (NOTA enabled)",
    nota: true,
    answers: [{ postId: "pres", nota: true }, council3],
    expect: "valid",
  },
  {
    name: "NOTA alone on a multi-seat post",
    nota: true,
    answers: [ok, { postId: "council", nota: true }],
    expect: "valid",
  },
  {
    name: "NOTA mixed with a Candidate",
    nota: true,
    answers: [{ postId: "pres", nota: true, candidateIds: ["asha"] }, council3],
    expect: ["nota_mixed"],
  },
  {
    name: "NOTA when NOTA is disabled",
    nota: false,
    answers: [{ postId: "pres", nota: true }, council3],
    expect: ["nota_disabled"],
  },
  { name: "Post skipped", answers: [ok], expect: ["missing_post"] },
  {
    name: "all Posts skipped (empty ballot)",
    answers: [],
    expect: ["missing_post", "missing_post"],
  },
  {
    name: "Post from another booth",
    answers: [ok, council3, { postId: "treasurer", candidateIds: ["x"] }],
    expect: ["unknown_post"],
  },
  {
    name: "the same Post answered twice",
    answers: [ok, ok, council3],
    expect: ["duplicate_post_answer"],
  },
  {
    name: "empty answer (neither Candidates nor NOTA)",
    answers: [{ postId: "pres", candidateIds: [] }, council3],
    expect: ["empty_answer"],
  },
  {
    name: "nota: false with no Candidates is an empty answer",
    answers: [{ postId: "pres", nota: false }, council3],
    expect: ["empty_answer"],
  },
  {
    name: "unknown fields are rejected",
    answers: [{ postId: "pres", candidateIds: ["asha"], note: "x" }, council3],
    expect: ["malformed"],
  },
  { name: "not an array", answers: { pres: ["asha"] }, expect: ["malformed"] },
  {
    name: "wrong types",
    answers: [{ postId: 1, candidateIds: "asha" }],
    expect: ["malformed"],
  },
  { name: "null", answers: null, expect: ["malformed"] },
];

describe("validateBallot", () => {
  it.each(CASES)("$name", (c) => {
    const result = validateBallot(definition(c.nota ?? false), c.answers);
    if (c.expect === "valid") {
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map((i) => i.code)).toEqual(c.expect);
    }
  });

  it("returns one selection per chosen Candidate, NOTA as a single selection", () => {
    const result = validateBallot(definition(true), [
      { postId: "pres", nota: true },
      { postId: "council", candidateIds: ["gus", "dev", "eli"] },
    ]);
    expect(result).toEqual({
      ok: true,
      selections: [
        { postId: "pres", candidateId: null, isNota: true },
        { postId: "council", candidateId: "gus", isNota: false },
        { postId: "council", candidateId: "dev", isNota: false },
        { postId: "council", candidateId: "eli", isNota: false },
      ],
    });
  });

  it("reports every problem on a ballot, naming the Post", () => {
    const result = validateBallot(definition(false), [
      { postId: "pres", candidateIds: ["asha", "asha"] },
    ]);
    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "duplicate_candidate", postId: "pres" },
        { code: "missing_post", postId: "council" },
      ],
    });
  });
});
