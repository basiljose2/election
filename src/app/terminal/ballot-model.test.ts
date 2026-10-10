import { describe, expect, it } from "vitest";
import {
  ballotReducer,
  buildAnswers,
  canCast,
  initialBallotState,
  isPostComplete,
  postHint,
  selectionOf,
  type BallotAction,
  type BallotState,
  type BoothBallot,
} from "./ballot-model";

const candidate = (id: string, serial: number) => ({
  id,
  serial,
  name: `Candidate ${id}`,
  photo_hash: null,
  symbol_hash: null,
  symbol_text: null,
});

const ballot = (nota: boolean): BoothBallot => ({
  nota_enabled: nota,
  posts: [
    {
      post_id: "pres",
      name: "President",
      seats: 1,
      candidates: [candidate("a", 1), candidate("b", 2), candidate("c", 3)],
      nota_serial: nota ? 4 : null,
    },
    {
      post_id: "council",
      name: "Council",
      seats: 3,
      candidates: [candidate("d", 1), candidate("e", 2), candidate("f", 3), candidate("g", 4)],
      nota_serial: nota ? 5 : null,
    },
  ],
});

const run = (state: BallotState, ...actions: BallotAction[]) =>
  actions.reduce(ballotReducer, state);

const unlocked = (nota = true) =>
  run(initialBallotState, { type: "unlock", ballot: ballot(nota), castToken: "token" });

const pick = (post: string, id: string): BallotAction => ({
  type: "toggle-candidate",
  postId: post,
  candidateId: id,
});

describe("ballot reducer: states", () => {
  it("starts locked and unlocks to the first Post", () => {
    expect(initialBallotState.phase).toEqual({ kind: "locked" });
    expect(unlocked().phase).toEqual({ kind: "post", index: 0, fromReview: false });
  });

  it("does not let a second session replace a ballot in progress", () => {
    const state = run(unlocked(), pick("pres", "a"));
    const again = ballotReducer(state, {
      type: "unlock",
      ballot: ballot(false),
      castToken: "other",
    });
    expect(again).toBe(state);
  });

  it("walks locked → post(0) → post(1) → review → casting → recorded → locked", () => {
    let state = run(unlocked(), pick("pres", "b"), { type: "next" });
    expect(state.phase).toEqual({ kind: "post", index: 1, fromReview: false });
    state = run(state, pick("council", "d"), pick("council", "e"), pick("council", "f"), {
      type: "next",
    });
    expect(state.phase).toEqual({ kind: "review" });
    state = run(state, { type: "cast", idempotencyKey: "key-key-key-key-key" });
    expect(state.phase).toEqual({ kind: "casting" });
    state = run(state, { type: "recorded" });
    expect(state.phase).toEqual({ kind: "recorded" });
    expect(state.selections).toEqual({});
    expect(state.castToken).toBeNull();
    expect(state.idempotencyKey).toBeNull();
    expect(state.ballot).toBeNull();
    expect(run(state, { type: "lock" })).toEqual(initialBallotState);
  });

  it("lock discards every choice (cancel)", () => {
    const state = run(unlocked(), pick("pres", "a"), { type: "lock" });
    expect(state).toEqual(initialBallotState);
  });

  it("cannot skip a Post or cast an incomplete ballot", () => {
    expect(run(unlocked(), { type: "next" }).phase).toMatchObject({ kind: "post", index: 0 });

    const partial = run(unlocked(), pick("pres", "a"), { type: "next" }, pick("council", "d"));
    expect(run(partial, { type: "next" }).phase).toMatchObject({ kind: "post", index: 1 });
    expect(run(partial, { type: "cast", idempotencyKey: "k" }).phase.kind).toBe("post");
    expect(canCast(partial)).toBe(false);
  });

  it("only the review screen can cast", () => {
    const state = run(unlocked(), pick("pres", "a"));
    expect(run(state, { type: "cast", idempotencyKey: "k" }).phase.kind).toBe("post");
  });
});

describe("ballot reducer: selection rules", () => {
  it("N = 1: choosing another Candidate moves the selection", () => {
    const state = run(unlocked(), pick("pres", "a"), pick("pres", "b"));
    expect(selectionOf(state, "pres")).toEqual({ candidateIds: ["b"], nota: false });
    expect(state.notice).toBeNull();
  });

  it("choosing a selected Candidate again deselects it", () => {
    const state = run(unlocked(), pick("pres", "a"), pick("pres", "a"));
    expect(selectionOf(state, "pres").candidateIds).toEqual([]);
  });

  it("N > 1: selecting beyond N is refused with the message, and nothing changes", () => {
    const atTwo = run(
      unlocked(),
      pick("pres", "a"),
      { type: "next" },
      pick("council", "d"),
      pick("council", "e"),
      pick("council", "f"),
    );
    const over = ballotReducer(atTwo, pick("council", "g"));
    expect(selectionOf(over, "council").candidateIds).toEqual(["d", "e", "f"]);
    expect(over.notice).toBe("You have already selected 3. Deselect one to change.");

    // Deselecting one clears the message and makes room.
    const freed = run(over, pick("council", "f"), pick("council", "g"));
    expect(selectionOf(freed, "council").candidateIds).toEqual(["d", "e", "g"]);
    expect(freed.notice).toBeNull();
  });

  it("N > 1: Next stays disabled until exactly N, and the hint counts down", () => {
    const state = run(unlocked(), pick("pres", "a"), { type: "next" }, pick("council", "d"));
    const post = state.ballot!.posts[1]!;
    expect(isPostComplete(post, selectionOf(state, "council"))).toBe(false);
    expect(postHint(post, selectionOf(state, "council"))).toBe("Select 2 more");

    const two = run(state, pick("council", "e"));
    expect(postHint(post, selectionOf(two, "council"))).toBe("Select 1 more");
    expect(run(two, { type: "next" }).phase).toMatchObject({ kind: "post", index: 1 });

    const three = run(two, pick("council", "f"));
    expect(isPostComplete(post, selectionOf(three, "council"))).toBe(true);
  });

  it("NOTA clears the Candidates, and a Candidate clears NOTA", () => {
    const withTwo = run(
      unlocked(),
      pick("pres", "a"),
      { type: "next" },
      pick("council", "d"),
      pick("council", "e"),
    );
    const nota = run(withTwo, { type: "toggle-nota", postId: "council" });
    expect(selectionOf(nota, "council")).toEqual({ candidateIds: [], nota: true });
    expect(run(nota, { type: "next" }).phase).toEqual({ kind: "review" });

    const back = run(nota, pick("council", "f"));
    expect(selectionOf(back, "council")).toEqual({ candidateIds: ["f"], nota: false });
  });

  it("NOTA is ignored when the Election does not enable it", () => {
    const state = run(unlocked(false), { type: "toggle-nota", postId: "pres" });
    expect(selectionOf(state, "pres")).toEqual({ candidateIds: [], nota: false });
  });

  it("ignores a Candidate of another Post", () => {
    const state = run(unlocked(), pick("pres", "d"));
    expect(selectionOf(state, "pres").candidateIds).toEqual([]);
  });
});

describe("ballot reducer: review", () => {
  const atReview = () =>
    run(
      unlocked(),
      pick("pres", "a"),
      { type: "next" },
      pick("council", "d"),
      pick("council", "e"),
      pick("council", "f"),
      { type: "next" },
    );

  it("Change returns to that Post with its selections, and Next returns to review", () => {
    const changing = run(atReview(), { type: "change", index: 0 });
    expect(changing.phase).toEqual({ kind: "post", index: 0, fromReview: true });
    expect(selectionOf(changing, "pres").candidateIds).toEqual(["a"]);

    const moved = run(changing, pick("pres", "c"), { type: "next" });
    expect(moved.phase).toEqual({ kind: "review" });
    expect(selectionOf(moved, "pres").candidateIds).toEqual(["c"]);
  });

  it("builds the answers the server validates", () => {
    expect(buildAnswers(atReview())).toEqual([
      { postId: "pres", candidateIds: ["a"] },
      { postId: "council", candidateIds: ["d", "e", "f"] },
    ]);
    expect(canCast(atReview())).toBe(true);
  });

  it("NOTA is sent as nota: true with no Candidates", () => {
    const state = run(
      unlocked(),
      { type: "toggle-nota", postId: "pres" },
      { type: "next" },
      pick("council", "d"),
      pick("council", "e"),
      pick("council", "f"),
      { type: "next" },
    );
    expect(buildAnswers(state)[0]).toEqual({ postId: "pres", nota: true });
    expect(canCast(state)).toBe(true);
  });
});
