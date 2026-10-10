import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AppendAuditEvent } from "@/lib/audit/append";
import { withTransaction } from "@/lib/db/pool";
import { logger } from "@/lib/log";
import { signalAfterCommit } from "@/lib/signals/publish";
import type { SignalPublisher } from "@/lib/signals/types";
import type { AuthenticatedTerminal } from "@/lib/terminals/credentials";
import { DEVICE_ACTOR } from "@/lib/terminals/pairing";
import { loadElectionSigningKey } from "./keys";
import { signSelection, type SelectionContent } from "./signing";
import { validateBallot, type BallotDefinitionView, type ValidationIssue } from "./validate";

/**
 * Device side of ballot casting: what the bound Voting Terminal may fetch and submit.
 *
 * Secrecy rules enforced here:
 *  - choices exist only in the request, in memory, and in the Vote Selection rows;
 *  - rows get random ids, no session/terminal/time reference, and are written in a random order;
 *  - audit events, signals, logs and responses never contain choices.
 */

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export interface CastingDeps {
  db: Pool;
  now(): Date;
  appendAudit: AppendAuditEvent;
  publisher: SignalPublisher;
  /** 32-byte key that unwraps election signing keys. */
  masterKey: Buffer;
  /** Test seam: called after each Vote Selection insert (fault injection). */
  afterSelectionInsert?: (index: number) => void;
}

/** Fisher–Yates with a CSPRNG. */
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface DefinitionRow {
  canonical_json: string;
}

async function loadDefinition(
  tx: Pick<PoolClient, "query">,
  electionId: string,
  boothId: string,
): Promise<BallotDefinitionView & Record<string, unknown>> {
  const { rows } = await tx.query<DefinitionRow>(
    `select d.canonical_json
       from public.ballot_definitions d
       join public.elections e on e.id = d.election_id and e.freeze_count = d.freeze_no
      where d.election_id = $1 and d.booth_id = $2`,
    [electionId, boothId],
  );
  if (!rows[0]) throw new Error("no Ballot Definition for this booth");
  return JSON.parse(rows[0].canonical_json) as BallotDefinitionView & Record<string, unknown>;
}

/**
 * The booth's current Ballot Definition for its Voting Terminal, with no Ballot Session and no
 * cast token. Definitions are public once the Election is frozen; the terminal preloads this so
 * that enabling a ballot only has to fetch the cast token.
 */
export async function fetchBoothDefinition(
  deps: Pick<CastingDeps, "db">,
  terminal: AuthenticatedTerminal,
): Promise<(BallotDefinitionView & Record<string, unknown>) | null> {
  if (terminal.type !== "voting") return null;
  try {
    return await withTransaction(deps.db, (tx) =>
      loadDefinition(tx, terminal.electionId, terminal.boothId),
    );
  } catch {
    return null;
  }
}

export type PendingBallot =
  | { status: "none" }
  | { status: "forbidden" }
  | {
      status: "pending";
      /** Single-use credential for the cast; replaced on every fetch by the bound terminal. */
      castToken: string;
      isMock: boolean;
      ballotDefinition: BallotDefinitionView & Record<string, unknown>;
    };

/**
 * The bound Voting Terminal asks whether a ballot is waiting. Only that terminal, and only
 * while the session is pending, receives the Ballot Definition and a cast token.
 */
export async function fetchPendingBallot(
  deps: Pick<CastingDeps, "db">,
  terminal: AuthenticatedTerminal,
): Promise<PendingBallot> {
  if (terminal.type !== "voting") return { status: "forbidden" };
  return withTransaction(deps.db, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      election_id: string;
      terminal_id: string;
      is_mock: boolean;
    }>(
      `select id, election_id, terminal_id, is_mock from public.ballot_sessions
        where booth_id = $1 and status = 'pending' for update`,
      [terminal.boothId],
    );
    const session = rows[0];
    if (!session) return { status: "none" } as const;
    if (session.terminal_id !== terminal.id) return { status: "forbidden" } as const;

    const castToken = randomBytes(32).toString("base64url");
    await tx.query("update public.ballot_sessions set cast_token_hash = $2 where id = $1", [
      session.id,
      sha256(castToken),
    ]);
    return {
      status: "pending",
      castToken,
      isMock: session.is_mock,
      ballotDefinition: await loadDefinition(tx, session.election_id, terminal.boothId),
    } as const;
  });
}

export type CastResult =
  | { status: "cast" }
  | { status: "invalid"; issues: ValidationIssue[] }
  | {
      status: "rejected";
      reason: "bad_token" | "wrong_terminal" | "cancelled" | "already_finished" | "bad_request";
    };

/**
 * Casts a ballot: validate, store every Vote Selection, mark the session Cast, count it and
 * audit it, all in one transaction. The response never echoes choices.
 */
export async function castBallot(
  deps: CastingDeps,
  terminal: AuthenticatedTerminal,
  input: { castToken: unknown; idempotencyKey: unknown; answers: unknown },
): Promise<CastResult> {
  const { castToken, idempotencyKey } = input;
  if (
    terminal.type !== "voting" ||
    typeof castToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(castToken) ||
    typeof idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    return { status: "rejected", reason: "bad_request" };
  }
  const tokenHash = sha256(castToken);
  const keyHash = sha256(idempotencyKey);
  const hooks: Array<() => Promise<void>> = [];

  const result = await withTransaction(deps.db, async (tx): Promise<CastResult> => {
    const found = await tx.query<{
      id: string;
      election_id: string;
      terminal_id: string;
      is_mock: boolean;
      mock_round: number | null;
      status: "pending" | "cast" | "cancelled";
      idempotency_key_hash: string | null;
    }>(
      `select id, election_id, terminal_id, is_mock, mock_round, status, idempotency_key_hash
         from public.ballot_sessions
        where cast_token_hash = $1 and booth_id = $2 for update`,
      [tokenHash, terminal.boothId],
    );
    const session = found.rows[0];
    if (!session) return { status: "rejected", reason: "bad_token" };
    if (session.terminal_id !== terminal.id)
      return { status: "rejected", reason: "wrong_terminal" };

    if (session.status === "cancelled") return { status: "rejected", reason: "cancelled" };
    if (session.status === "cast") {
      // A repeat of the original request returns the original success; anything else is refused.
      return session.idempotency_key_hash === keyHash
        ? { status: "cast" }
        : { status: "rejected", reason: "already_finished" };
    }

    const definition = await loadDefinition(tx, session.election_id, terminal.boothId);
    const validation = validateBallot(definition, input.answers);
    if (!validation.ok) {
      // Codes and Post ids only: the submitted choices are never logged.
      logger.warn("cast.invalid", {
        booth_id: terminal.boothId,
        election_id: session.election_id,
        error_code: "invalid_ballot",
        issue_codes: validation.issues.map((i) => i.code),
      });
      return { status: "invalid", issues: validation.issues };
    }

    const signing = await loadElectionSigningKey(tx, session.election_id, deps.masterKey);

    // Each selection gets its own random id and signature; the order they are written in is
    // random, so neither ids nor row order follow the ballot's structure.
    const rows = shuffle(validation.selections).map((draft) => {
      const content: SelectionContent = {
        id: randomUUID(),
        election_id: session.election_id,
        booth_id: terminal.boothId,
        post_id: draft.postId,
        candidate_id: draft.candidateId,
        is_nota: draft.isNota,
        is_mock: session.is_mock,
        mock_round: session.mock_round,
      };
      return { content, signature: signSelection(signing.privateKey, content) };
    });

    for (const [index, { content, signature }] of rows.entries()) {
      await tx.query(
        `insert into public.vote_selections
           (id, election_id, booth_id, post_id, candidate_id, is_nota, is_mock, mock_round, signature)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          content.id,
          content.election_id,
          content.booth_id,
          content.post_id,
          content.candidate_id,
          content.is_nota,
          content.is_mock,
          content.mock_round,
          signature,
        ],
      );
      deps.afterSelectionInsert?.(index);
    }

    await tx.query(
      `update public.ballot_sessions
          set status = 'cast', finished_at = $2, idempotency_key_hash = $3
        where id = $1`,
      [session.id, deps.now(), keyHash],
    );
    if (!session.is_mock) {
      await tx.query(
        "update public.booth_counters set ballots_cast = ballots_cast + 1 where booth_id = $1",
        [terminal.boothId],
      );
    }
    await deps.appendAudit(tx, {
      electionId: session.election_id,
      eventType: "ballot.cast",
      actor: DEVICE_ACTOR(terminal.id),
      target: { type: "booth", id: terminal.boothId },
      detail: { session_id: session.id, is_mock: session.is_mock, mock_round: session.mock_round },
    });
    await signalAfterCommit(
      { tx, onCommit: (fn) => hooks.push(fn) },
      deps.publisher,
      terminal.boothId,
      "ballot-cast",
    );
    return { status: "cast" };
  });

  for (const hook of hooks) await hook().catch(() => undefined);
  return result;
}

/** What a rejected cast looks like when logged: codes and ids, never the request body. */
export function logCastFailure(
  terminal: AuthenticatedTerminal,
  result: CastResult | { status: "error" },
) {
  logger.warn("cast.failed", {
    booth_id: terminal.boothId,
    terminal_id: terminal.id,
    status: result.status,
    error_code: "reason" in result ? result.reason : result.status,
  });
}
