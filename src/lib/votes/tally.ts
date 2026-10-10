import { sign, verify, type KeyObject } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, type JsonValue } from "@/lib/audit/canonical-json";
import { sha256Hex } from "@/lib/audit/chain";
import type { HookRegistry } from "@/lib/lifecycle/engine";
import { loadElectionSigningKey } from "./keys";
import { publicKeyFromBase64Url } from "./signing";

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Booth Tallies: the signed, fixed account of what a booth produced, created in the same
 * transaction that closes it. A tally holds totals and hashes only: never a per-candidate or
 * NOTA count.
 */

/** What the sealed `booth_integrity_digest` function returns. */
export interface BoothDigest {
  selection_rows: number;
  merkle_root: string;
  bad_signatures: number;
  unmapped_rows: number;
  posts: Array<{ post_id: string; seats: number; answers: number; divisible: boolean }>;
}

export async function readBoothDigest(db: Queryable, boothId: string): Promise<BoothDigest> {
  const { rows } = await db.query<{ digest: BoothDigest }>(
    "select public.booth_integrity_digest($1) as digest",
    [boothId],
  );
  return rows[0]!.digest;
}

export type TallyCheck =
  | "selection_signatures"
  | "no_unmapped_selections"
  | "divisible_by_seats"
  | "answers_match_ballots";

export interface TallyFailure {
  check: TallyCheck;
  post_id?: string;
  /** Counts that explain the failure (answers vs ballots, number of bad signatures). */
  expected?: number;
  actual?: number;
}

export interface TallyContent {
  version: 1;
  election_id: string;
  booth_id: string;
  closed_at: string;
  ballots_cast: number;
  ballots_cancelled: number;
  mock_rounds: number;
  selection_rows: number;
  posts: Array<{ post_id: string; answers: number }>;
  merkle_root: string;
  status: "pass" | "failed";
  failures: TallyFailure[];
}

/**
 * The consistency checks of the close: every mapped Post's candidate rows divide by its seats
 * and its answers equal the ballots cast, no row sits on an unmapped Post, and every
 * signature verifies.
 */
export function evaluateDigest(digest: BoothDigest, ballotsCast: number): TallyFailure[] {
  const failures: TallyFailure[] = [];
  if (digest.bad_signatures > 0) {
    failures.push({ check: "selection_signatures", actual: digest.bad_signatures });
  }
  if (digest.unmapped_rows > 0) {
    failures.push({ check: "no_unmapped_selections", actual: digest.unmapped_rows });
  }
  for (const post of digest.posts) {
    if (!post.divisible) {
      failures.push({ check: "divisible_by_seats", post_id: post.post_id });
    }
    if (post.answers !== ballotsCast) {
      failures.push({
        check: "answers_match_ballots",
        post_id: post.post_id,
        expected: ballotsCast,
        actual: post.answers,
      });
    }
  }
  return failures;
}

export const canonicalTally = (content: TallyContent): string =>
  canonicalJson(content as unknown as JsonValue);

export const tallyHash = (canonical: string): string => sha256Hex(canonical);

export function signTally(privateKey: KeyObject, canonical: string): string {
  return sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url");
}

export function verifyTally(publicKey: string, canonical: string, signature: string): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    return verify(
      null,
      Buffer.from(canonical, "utf8"),
      publicKeyFromBase64Url(publicKey),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/** The first 8 hex characters, grouped, for reading aloud or writing down. */
export const shortHash = (hash: string): string => `${hash.slice(0, 4)}-${hash.slice(4, 8)}`;

export interface StoredTally {
  id: string;
  electionId: string;
  boothId: string;
  status: "pass" | "failed";
  canonicalJson: string;
  tallyHash: string;
  signature: string;
  content: TallyContent;
}

export async function loadBoothTally(db: Queryable, boothId: string): Promise<StoredTally | null> {
  const { rows } = await db.query<{
    id: string;
    election_id: string;
    booth_id: string;
    status: "pass" | "failed";
    canonical_json: string;
    tally_hash: string;
    signature: string;
  }>(
    `select id, election_id, booth_id, status, canonical_json, tally_hash, signature
       from public.booth_tallies where booth_id = $1`,
    [boothId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    electionId: row.election_id,
    boothId: row.booth_id,
    status: row.status,
    canonicalJson: row.canonical_json,
    tallyHash: row.tally_hash,
    signature: row.signature,
    content: JSON.parse(row.canonical_json) as TallyContent,
  };
}

/** Closed booths whose tally is FAILED (for the Returning Officer's dashboard alert). */
export async function listFailedTallies(
  db: Queryable,
  electionId: string,
): Promise<
  Array<{ boothId: string; boothName: string; failedChecks: string[]; tallyHash: string }>
> {
  const { rows } = await db.query<{
    booth_id: string;
    name: string;
    canonical_json: string;
    tally_hash: string;
  }>(
    `select t.booth_id, b.name, t.canonical_json, t.tally_hash
       from public.booth_tallies t join public.booths b on b.id = t.booth_id
      where t.election_id = $1 and t.status = 'failed' order by b.name`,
    [electionId],
  );
  return rows.map((r) => ({
    boothId: r.booth_id,
    boothName: r.name,
    failedChecks: [
      ...new Set((JSON.parse(r.canonical_json) as TallyContent).failures.map((f) => f.check)),
    ],
    tallyHash: r.tally_hash,
  }));
}

/**
 * Creates and stores the booth's tally. Must run after the booth's state has changed to
 * Closed, in the closing transaction.
 */
export async function createBoothTally(
  tx: Queryable,
  input: { electionId: string; boothId: string; closedAt: Date; masterKey: Buffer },
): Promise<StoredTally> {
  const counters = await tx.query<{
    ballots_cast: string;
    ballots_cancelled: string;
    mock_round: number;
  }>(
    "select ballots_cast, ballots_cancelled, mock_round from public.booth_counters where booth_id = $1",
    [input.boothId],
  );
  const c = counters.rows[0]!;
  const ballotsCast = Number(c.ballots_cast);

  const digest = await readBoothDigest(tx, input.boothId);
  const failures = evaluateDigest(digest, ballotsCast);
  const content: TallyContent = {
    version: 1,
    election_id: input.electionId,
    booth_id: input.boothId,
    closed_at: input.closedAt.toISOString(),
    ballots_cast: ballotsCast,
    ballots_cancelled: Number(c.ballots_cancelled),
    mock_rounds: c.mock_round,
    selection_rows: digest.selection_rows,
    posts: digest.posts.map((p) => ({ post_id: p.post_id, answers: p.answers })),
    merkle_root: digest.merkle_root,
    status: failures.length === 0 ? "pass" : "failed",
    failures,
  };

  const { privateKey } = await loadElectionSigningKey(tx, input.electionId, input.masterKey);
  const canonical = canonicalTally(content);
  const hash = tallyHash(canonical);
  const signature = signTally(privateKey, canonical);
  const { rows } = await tx.query<{ id: string }>(
    `insert into public.booth_tallies
       (election_id, booth_id, status, canonical_json, tally_hash, signature, created_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [input.electionId, input.boothId, content.status, canonical, hash, signature, input.closedAt],
  );
  return {
    id: rows[0]!.id,
    electionId: input.electionId,
    boothId: input.boothId,
    status: content.status,
    canonicalJson: canonical,
    tallyHash: hash,
    signature,
    content,
  };
}

/**
 * Close hooks: every Closed booth, force-closed ones included, gets a tally. If no tally can
 * be signed the close is refused: a booth must never be Closed without its account.
 */
export function tallyHooks(masterKey: () => Buffer): HookRegistry {
  return (["close_poll", "force_close_poll"] as const).map((action) => ({
    action,
    async run(ctx, info) {
      const tally = await createBoothTally(ctx.tx, {
        electionId: info.electionId,
        boothId: info.boothId!,
        closedAt: ctx.now(),
        masterKey: masterKey(),
      });
      return {
        booth_tally: {
          tally_hash: tally.tallyHash,
          tally_status: tally.status,
          failed_checks: tally.content.failures.map((f) => f.check),
        },
      };
    },
  }));
}
