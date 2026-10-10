import { z } from "zod";

/**
 * Ballot validation, shared by the server (authoritative), the voting terminal (to guide the
 * voter) and the public verifier. Pure: no database, no I/O.
 *
 * A ballot must answer EVERY contested Post of the booth and nothing else. For a Post with N
 * seats the answer is exactly N distinct Candidates of that Post, or NOTA alone (only when the
 * Election enables NOTA). Anything else rejects the whole ballot.
 */

/** The parts of a booth's Ballot Definition that validation needs. */
export interface BallotDefinitionView {
  nota_enabled: boolean;
  posts: Array<{
    post_id: string;
    seats: number;
    candidates: Array<{ id: string }>;
  }>;
}

export interface Answer {
  postId: string;
  candidateIds?: string[];
  nota?: boolean;
}

/** Wire format. Strict: unknown fields are an error, not ignored. */
export const answersSchema = z
  .array(
    z
      .object({
        postId: z.string().min(1).max(64),
        candidateIds: z.array(z.string().min(1).max(64)).max(100).optional(),
        nota: z.boolean().optional(),
      })
      .strict(),
  )
  .max(100);

export type ValidationCode =
  | "malformed"
  | "unknown_post"
  | "duplicate_post_answer"
  | "missing_post"
  | "empty_answer"
  | "wrong_count"
  | "duplicate_candidate"
  | "unknown_candidate"
  | "nota_disabled"
  | "nota_mixed";

export interface ValidationIssue {
  code: ValidationCode;
  postId?: string;
}

/** One stored choice, before it is given an id and a signature. */
export interface SelectionDraft {
  postId: string;
  candidateId: string | null;
  isNota: boolean;
}

export type BallotValidation =
  { ok: true; selections: SelectionDraft[] } | { ok: false; issues: ValidationIssue[] };

export function validateBallot(
  definition: BallotDefinitionView,
  rawAnswers: unknown,
): BallotValidation {
  const parsed = answersSchema.safeParse(rawAnswers);
  if (!parsed.success) return { ok: false, issues: [{ code: "malformed" }] };
  const answers = parsed.data;

  const issues: ValidationIssue[] = [];
  const posts = new Map(definition.posts.map((p) => [p.post_id, p]));
  const answered = new Set<string>();
  const selections: SelectionDraft[] = [];

  for (const answer of answers) {
    const post = posts.get(answer.postId);
    if (!post) {
      issues.push({ code: "unknown_post", postId: answer.postId });
      continue;
    }
    if (answered.has(answer.postId)) {
      issues.push({ code: "duplicate_post_answer", postId: answer.postId });
      continue;
    }
    answered.add(answer.postId);

    const chosen = answer.candidateIds ?? [];
    const nota = answer.nota === true;

    if (nota) {
      if (!definition.nota_enabled) {
        issues.push({ code: "nota_disabled", postId: answer.postId });
      } else if (chosen.length > 0) {
        issues.push({ code: "nota_mixed", postId: answer.postId });
      } else {
        selections.push({ postId: answer.postId, candidateId: null, isNota: true });
      }
      continue;
    }

    if (chosen.length === 0) {
      issues.push({ code: "empty_answer", postId: answer.postId });
      continue;
    }
    if (new Set(chosen).size !== chosen.length) {
      issues.push({ code: "duplicate_candidate", postId: answer.postId });
      continue;
    }
    const valid = new Set(post.candidates.map((c) => c.id));
    if (chosen.some((id) => !valid.has(id))) {
      issues.push({ code: "unknown_candidate", postId: answer.postId });
      continue;
    }
    if (chosen.length !== post.seats) {
      issues.push({ code: "wrong_count", postId: answer.postId });
      continue;
    }
    for (const candidateId of chosen) {
      selections.push({ postId: answer.postId, candidateId, isNota: false });
    }
  }

  for (const post of definition.posts) {
    if (!answered.has(post.post_id)) issues.push({ code: "missing_post", postId: post.post_id });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, selections };
}
