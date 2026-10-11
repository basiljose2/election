/**
 * Result computation for one Post. Pure: no database, no clock, no I/O, so the server, the
 * public verifier and the tests all compute exactly the same thing from the same counts.
 *
 * Rules (see openspec: results-declaration):
 *  - Candidates are ranked by real votes, NOTA excluded.
 *  - Let V be the votes of the N-th ranked Candidate. If nobody ranked below N has V votes,
 *    the top N are Elected. Otherwise Candidates above V are Elected, the remaining seats are
 *    a Tie, and every Candidate on exactly V votes is listed as tied. A tie is never broken.
 *  - NOTA is never Elected; the Post is flagged when NOTA beats any Elected Candidate.
 */

export interface PostInput {
  postId: string;
  name: string;
  seats: number;
  /** Frozen as uncontested at setup: its Candidates are Elected unopposed, with no ballots. */
  uncontested: boolean;
  candidates: Array<{ id: string; name: string; serial: number | null }>;
}

export interface PostCounts {
  /** Real votes per Candidate id; a Candidate missing from the map has 0. */
  candidates: Readonly<Record<string, number>>;
  /** NOTA votes (0 when NOTA is disabled). */
  nota: number;
}

export type CandidateOutcome = "elected" | "tied" | "not_elected" | "unopposed" | "withheld";
export type PostStatus = "elected" | "tie" | "unopposed" | "withheld";

export interface CandidateResult {
  id: string;
  name: string;
  serial: number | null;
  /** null for uncontested and withheld Posts: no counts exist or are shown. */
  votes: number | null;
  outcome: CandidateOutcome;
}

export interface PostResult {
  postId: string;
  name: string;
  seats: number;
  status: PostStatus;
  /** Ranked by votes (descending), ties kept in serial order. */
  candidates: CandidateResult[];
  /** null when NOTA is disabled, or for uncontested and withheld Posts. */
  nota: number | null;
  /** Ballot answers for the Post: candidate votes ÷ seats + NOTA. null when no counts. */
  answers: number | null;
  electedCount: number;
  /** Seats left open by a tie. */
  tiedSeats: number;
  notaExceededWinner: boolean;
  /** Votes of the last Elected Candidate minus those of the next Candidate; null if n/a. */
  margin: number | null;
  /** Why the Post is withheld (no counts are shown). */
  withheldReason: string | null;
}

const bySerial = (a: { serial: number | null; name: string }, b: typeof a) =>
  (a.serial ?? Number.MAX_SAFE_INTEGER) - (b.serial ?? Number.MAX_SAFE_INTEGER) ||
  a.name.localeCompare(b.name);

export function uncontestedResult(post: PostInput): PostResult {
  return {
    postId: post.postId,
    name: post.name,
    seats: post.seats,
    status: "unopposed",
    candidates: [...post.candidates].sort(bySerial).map((c) => ({
      id: c.id,
      name: c.name,
      serial: c.serial,
      votes: null,
      outcome: "unopposed",
    })),
    nota: null,
    answers: null,
    electedCount: post.candidates.length,
    tiedSeats: 0,
    notaExceededWinner: false,
    margin: null,
    withheldReason: null,
  };
}

export function withheldResult(post: PostInput, reason: string): PostResult {
  return {
    postId: post.postId,
    name: post.name,
    seats: post.seats,
    status: "withheld",
    candidates: [...post.candidates].sort(bySerial).map((c) => ({
      id: c.id,
      name: c.name,
      serial: c.serial,
      votes: null,
      outcome: "withheld",
    })),
    nota: null,
    answers: null,
    electedCount: 0,
    tiedSeats: 0,
    notaExceededWinner: false,
    margin: null,
    withheldReason: reason,
  };
}

export function computePostResult(
  post: PostInput,
  counts: PostCounts,
  options: { notaEnabled: boolean },
): PostResult {
  if (post.uncontested) return uncontestedResult(post);

  const ranked = post.candidates
    .map((c) => ({ ...c, votes: counts.candidates[c.id] ?? 0 }))
    .sort((a, b) => b.votes - a.votes || bySerial(a, b));

  const seats = post.seats;
  const nota = options.notaEnabled ? counts.nota : null;
  const candidateVotes = ranked.reduce((sum, c) => sum + c.votes, 0);
  const answers = Math.floor(candidateVotes / seats) + (nota ?? 0);

  const outcomes = new Map<string, CandidateOutcome>();
  let status: PostStatus = "elected";
  let tiedSeats = 0;

  if (ranked.length <= seats) {
    // Fewer Candidates than seats: every Candidate takes a seat.
    for (const c of ranked) outcomes.set(c.id, "elected");
  } else {
    const cutoff = ranked[seats - 1]!.votes;
    const nextVotes = ranked[seats]!.votes;
    if (nextVotes < cutoff) {
      for (const [i, c] of ranked.entries()) {
        outcomes.set(c.id, i < seats ? "elected" : "not_elected");
      }
    } else {
      // The cut-off is shared: those above it are Elected, those on it are tied.
      const above = ranked.filter((c) => c.votes > cutoff);
      for (const c of ranked) {
        outcomes.set(
          c.id,
          c.votes > cutoff ? "elected" : c.votes === cutoff ? "tied" : "not_elected",
        );
      }
      status = "tie";
      tiedSeats = seats - above.length;
    }
  }

  const candidates: CandidateResult[] = ranked.map((c) => ({
    id: c.id,
    name: c.name,
    serial: c.serial,
    votes: c.votes,
    outcome: outcomes.get(c.id)!,
  }));
  const elected = candidates.filter((c) => c.outcome === "elected");

  // "NOTA exceeded winner": NOTA beats the votes of any Elected Candidate.
  const notaExceededWinner =
    nota !== null && elected.some((c) => c.votes !== null && nota > c.votes);

  let margin: number | null = null;
  if (elected.length > 0) {
    const lastElected = elected[elected.length - 1]!;
    const next = candidates.find((c) => c.outcome !== "elected");
    if (next && lastElected.votes !== null && next.votes !== null) {
      margin = lastElected.votes - next.votes;
    }
  }

  return {
    postId: post.postId,
    name: post.name,
    seats,
    status,
    candidates,
    nota,
    answers,
    electedCount: elected.length,
    tiedSeats,
    notaExceededWinner,
    margin,
    withheldReason: null,
  };
}
