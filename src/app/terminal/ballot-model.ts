import { validateBallot, type Answer, type BallotDefinitionView } from "@/lib/votes/validate";
import { STRINGS } from "./strings";

/** The parts of a booth's Ballot Definition the screen draws. */
export interface BallotCandidate {
  id: string;
  serial: number | null;
  name: string;
  photo_hash: string | null;
  symbol_hash: string | null;
  symbol_text: string | null;
}

export interface BallotPost {
  post_id: string;
  name: string;
  seats: number;
  candidates: BallotCandidate[];
  nota_serial: number | null;
}

export interface BoothBallot extends BallotDefinitionView {
  posts: BallotPost[];
}

export interface Selection {
  candidateIds: string[];
  nota: boolean;
}

export type Phase =
  | { kind: "locked" }
  | { kind: "post"; index: number; fromReview: boolean }
  | { kind: "review" }
  | { kind: "casting" }
  | { kind: "recorded" };

/**
 * Everything the voter has chosen exists only here, in memory. Going back to `locked` replaces
 * the whole state, so no choice, token or key survives a ballot.
 */
export interface BallotState {
  phase: Phase;
  ballot: BoothBallot | null;
  castToken: string | null;
  idempotencyKey: string | null;
  selections: Record<string, Selection>;
  notice: string | null;
  /** Why the terminal went back to locked (for example a cancelled ballot); never a choice. */
  lockedNotice: string | null;
}

export const initialBallotState: BallotState = {
  phase: { kind: "locked" },
  ballot: null,
  castToken: null,
  idempotencyKey: null,
  selections: {},
  notice: null,
  lockedNotice: null,
};

export type BallotAction =
  | { type: "unlock"; ballot: BoothBallot; castToken: string }
  | { type: "toggle-candidate"; postId: string; candidateId: string }
  | { type: "toggle-nota"; postId: string }
  | { type: "next" }
  | { type: "back" }
  | { type: "change"; index: number }
  | { type: "cast"; idempotencyKey: string }
  | { type: "recorded" }
  | { type: "lock"; notice?: string };

const emptySelection: Selection = { candidateIds: [], nota: false };

export const selectionOf = (state: BallotState, postId: string): Selection =>
  state.selections[postId] ?? emptySelection;

/** Exactly N Candidates, or NOTA alone. */
export function isPostComplete(post: BallotPost, selection: Selection): boolean {
  return selection.nota || selection.candidateIds.length === post.seats;
}

/** What the screen says under the instruction: how many more, or that Next is ready. */
export function postHint(post: BallotPost, selection: Selection): string {
  if (selection.nota) return STRINGS.notaChosen;
  const remaining = post.seats - selection.candidateIds.length;
  return remaining > 0 ? STRINGS.selectMore(remaining) : STRINGS.readyForNext;
}

/** The ballot as the server validates it. */
export function buildAnswers(state: BallotState): Answer[] {
  if (!state.ballot) return [];
  return state.ballot.posts.map((post): Answer => {
    const selection = selectionOf(state, post.post_id);
    return selection.nota
      ? { postId: post.post_id, nota: true }
      : { postId: post.post_id, candidateIds: [...selection.candidateIds] };
  });
}

/** Cast is possible only when the shared validation accepts the whole ballot. */
export function canCast(state: BallotState): boolean {
  return state.ballot !== null && validateBallot(state.ballot, buildAnswers(state)).ok;
}

function withSelection(state: BallotState, postId: string, selection: Selection): BallotState {
  return { ...state, selections: { ...state.selections, [postId]: selection }, notice: null };
}

export function ballotReducer(state: BallotState, action: BallotAction): BallotState {
  if (action.type === "lock") return { ...initialBallotState, lockedNotice: action.notice ?? null };
  if (action.type === "unlock") {
    // Only a locked terminal can be unlocked; a second session never replaces a ballot in progress.
    if (state.phase.kind !== "locked") return state;
    if (action.ballot.posts.length === 0) return state;
    return {
      ...initialBallotState,
      ballot: action.ballot,
      castToken: action.castToken,
      phase: { kind: "post", index: 0, fromReview: false },
    };
  }

  const { ballot, phase } = state;
  if (!ballot) return state;

  switch (action.type) {
    case "toggle-candidate": {
      if (phase.kind !== "post") return state;
      const post = ballot.posts[phase.index];
      if (!post || post.post_id !== action.postId) return state;
      if (!post.candidates.some((c) => c.id === action.candidateId)) return state;
      const current = selectionOf(state, post.post_id);

      if (current.candidateIds.includes(action.candidateId)) {
        return withSelection(state, post.post_id, {
          nota: false,
          candidateIds: current.candidateIds.filter((id) => id !== action.candidateId),
        });
      }
      if (post.seats === 1) {
        // A single seat: choosing another Candidate moves the selection (and clears NOTA).
        return withSelection(state, post.post_id, {
          nota: false,
          candidateIds: [action.candidateId],
        });
      }
      const base = current.nota ? [] : current.candidateIds;
      if (base.length >= post.seats) {
        return { ...state, notice: STRINGS.capReached(post.seats) };
      }
      return withSelection(state, post.post_id, {
        nota: false,
        candidateIds: [...base, action.candidateId],
      });
    }

    case "toggle-nota": {
      if (phase.kind !== "post" || !ballot.nota_enabled) return state;
      const post = ballot.posts[phase.index];
      if (!post || post.post_id !== action.postId) return state;
      // NOTA is an alternative to the Candidates: choosing it clears them.
      return withSelection(state, post.post_id, {
        nota: !selectionOf(state, post.post_id).nota,
        candidateIds: [],
      });
    }

    case "next": {
      if (phase.kind !== "post") return state;
      const post = ballot.posts[phase.index];
      if (!post || !isPostComplete(post, selectionOf(state, post.post_id))) return state;
      const last = phase.index === ballot.posts.length - 1;
      return {
        ...state,
        notice: null,
        phase:
          phase.fromReview || last
            ? { kind: "review" }
            : { kind: "post", index: phase.index + 1, fromReview: false },
      };
    }

    case "back": {
      if (phase.kind === "review") {
        return {
          ...state,
          notice: null,
          phase: { kind: "post", index: ballot.posts.length - 1, fromReview: false },
        };
      }
      if (phase.kind !== "post" || phase.fromReview || phase.index === 0) return state;
      return {
        ...state,
        notice: null,
        phase: { kind: "post", index: phase.index - 1, fromReview: false },
      };
    }

    case "change": {
      if (phase.kind !== "review" || !ballot.posts[action.index]) return state;
      return {
        ...state,
        notice: null,
        phase: { kind: "post", index: action.index, fromReview: true },
      };
    }

    case "cast": {
      if (phase.kind !== "review" || !canCast(state)) return state;
      return {
        ...state,
        notice: null,
        idempotencyKey: action.idempotencyKey,
        phase: { kind: "casting" },
      };
    }

    case "recorded": {
      if (phase.kind !== "casting") return state;
      // Choices, token and key are dropped as soon as the vote is recorded.
      return { ...initialBallotState, phase: { kind: "recorded" } };
    }
  }
}
