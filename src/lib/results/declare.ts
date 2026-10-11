import type { Pool, PoolClient } from "pg";
import { canonicalJson, type JsonValue } from "@/lib/audit/canonical-json";
import { sha256Hex } from "@/lib/audit/chain";
import type { HookRegistry } from "@/lib/lifecycle/engine";
import { fail, pass, type GuardRegistry } from "@/lib/lifecycle/guards";
import { latestReconciliation } from "@/lib/reconciliation/run";
import { loadElectionSigningKey } from "@/lib/votes/keys";
import { signTally, verifyTally } from "@/lib/votes/tally";
import {
  computePostResult,
  uncontestedResult,
  withheldResult,
  type PostInput,
  type PostResult,
} from "./compute";

type Queryable = Pick<Pool | PoolClient, "query">;

/** The signed Result: everything the dashboard and the exports show, and nothing else. */
export interface ResultDocument {
  version: 1;
  election_id: string;
  election_name: string;
  declared_at: string;
  setup_hash: string;
  nota_enabled: boolean;
  totals: { ballots_cast: number; ballots_cancelled: number; booths: number };
  posts: PostResult[];
  /** Per-booth votes for every declared (contested, not withheld) Post. */
  booth_wise: Array<{
    booth_id: string;
    booth_name: string;
    post_id: string;
    /** candidate_id null is NOTA. */
    rows: Array<{ candidate_id: string | null; votes: number }>;
  }>;
}

export interface StoredResult {
  id: string;
  electionId: string;
  canonicalJson: string;
  resultHash: string;
  signature: string;
  declaredAt: string;
  document: ResultDocument;
}

interface SetupPost {
  id: string;
  name: string;
  seats: number;
  display_order: number;
  uncontested: boolean;
  candidates: Array<{ id: string; serial: number | null; name: string }>;
}

async function loadSetup(db: Queryable, electionId: string) {
  const { rows } = await db.query<{ canonical_json: string; setup_hash: string }>(
    `select s.canonical_json, s.setup_hash
       from public.setup_snapshots s
       join public.elections e on e.id = s.election_id and e.freeze_count = s.freeze_no
      where s.election_id = $1`,
    [electionId],
  );
  if (!rows[0]) throw new Error("the Election has no frozen setup");
  const setup = JSON.parse(rows[0].canonical_json) as {
    election: { name: string; nota_enabled: boolean };
    posts: SetupPost[];
  };
  return { setup, setupHash: rows[0].setup_hash };
}

/**
 * Builds the Result from the sealed readers and the reconciliation run of THIS transaction.
 * Posts that did not pass reconciliation are withheld with no counts at all.
 */
export async function buildResultDocument(
  db: Queryable,
  input: { electionId: string; declaredAt: Date },
): Promise<ResultDocument> {
  const { electionId } = input;
  const { setup, setupHash } = await loadSetup(db, electionId);
  const notaEnabled = setup.election.nota_enabled;

  const report = await latestReconciliation(db, electionId);
  if (!report) throw new Error("no reconciliation has run for this declaration");
  const passed = new Map(report.posts.map((p) => [p.postId, p.status === "pass"]));

  const totals = await db.query<{ post_id: string; candidate_id: string | null; votes: string }>(
    "select post_id, candidate_id, votes from public.election_tally($1)",
    [electionId],
  );
  const perPost = new Map<string, { candidates: Record<string, number>; nota: number }>();
  for (const row of totals.rows) {
    const entry = perPost.get(row.post_id) ?? { candidates: {}, nota: 0 };
    if (row.candidate_id) entry.candidates[row.candidate_id] = Number(row.votes);
    else entry.nota += Number(row.votes);
    perPost.set(row.post_id, entry);
  }

  const posts: PostResult[] = [];
  const declared = new Set<string>();
  for (const sp of [...setup.posts].sort((a, b) => a.display_order - b.display_order)) {
    const post: PostInput = {
      postId: sp.id,
      name: sp.name,
      seats: sp.seats,
      uncontested: sp.uncontested,
      candidates: sp.candidates.map((c) => ({ id: c.id, name: c.name, serial: c.serial })),
    };
    if (sp.uncontested) {
      posts.push(uncontestedResult(post));
    } else if (passed.get(sp.id) !== true) {
      posts.push(withheldResult(post, "integrity check failed"));
    } else {
      posts.push(
        computePostResult(post, perPost.get(sp.id) ?? { candidates: {}, nota: 0 }, { notaEnabled }),
      );
      declared.add(sp.id);
    }
  }

  const booths = await db.query<{
    id: string;
    name: string;
    ballots_cast: string;
    ballots_cancelled: string;
  }>(
    `select b.id, b.name, c.ballots_cast, c.ballots_cancelled
       from public.booths b join public.booth_counters c on c.booth_id = b.id
      where b.election_id = $1 order by b.name, b.id`,
    [electionId],
  );
  const boothRows = await db.query<{
    booth_id: string;
    post_id: string;
    candidate_id: string | null;
    votes: string;
  }>("select booth_id, post_id, candidate_id, votes from public.election_booth_tally($1)", [
    electionId,
  ]);
  const boothWise: ResultDocument["booth_wise"] = [];
  for (const booth of booths.rows) {
    for (const post of posts.filter((p) => declared.has(p.postId))) {
      const rows = boothRows.rows
        .filter((r) => r.booth_id === booth.id && r.post_id === post.postId)
        .map((r) => ({ candidate_id: r.candidate_id, votes: Number(r.votes) }))
        .sort((a, b) => (a.candidate_id ?? "~").localeCompare(b.candidate_id ?? "~"));
      if (rows.length > 0) {
        boothWise.push({
          booth_id: booth.id,
          booth_name: booth.name,
          post_id: post.postId,
          rows,
        });
      }
    }
  }

  return {
    version: 1,
    election_id: electionId,
    election_name: setup.election.name,
    declared_at: input.declaredAt.toISOString(),
    setup_hash: setupHash,
    nota_enabled: notaEnabled,
    totals: {
      ballots_cast: booths.rows.reduce((s, b) => s + Number(b.ballots_cast), 0),
      ballots_cancelled: booths.rows.reduce((s, b) => s + Number(b.ballots_cancelled), 0),
      booths: booths.rows.length,
    },
    posts,
    booth_wise: boothWise,
  };
}

export const canonicalResult = (doc: ResultDocument): string =>
  canonicalJson(doc as unknown as JsonValue);

/** Verifies a stored Result's hash and signature against the Election's public key. */
export function verifyResult(
  publicKey: string,
  result: Pick<StoredResult, "canonicalJson" | "resultHash" | "signature">,
): boolean {
  return (
    sha256Hex(result.canonicalJson) === result.resultHash &&
    verifyTally(publicKey, result.canonicalJson, result.signature)
  );
}

export async function loadResult(db: Queryable, electionId: string): Promise<StoredResult | null> {
  const { rows } = await db.query<{
    id: string;
    election_id: string;
    canonical_json: string;
    result_hash: string;
    signature: string;
    declared_at: Date;
  }>(
    `select id, election_id, canonical_json, result_hash, signature, declared_at
       from public.results where election_id = $1`,
    [electionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    electionId: row.election_id,
    canonicalJson: row.canonical_json,
    resultHash: row.result_hash,
    signature: row.signature,
    declaredAt: row.declared_at.toISOString(),
    document: JSON.parse(row.canonical_json) as ResultDocument,
  };
}

/**
 * Declaration, as a hook of the `declare_results` transition: it runs inside the transition's
 * transaction, after the guards (re-authentication, a fresh reconciliation) and the status
 * change. Computing, storing and signing therefore commit or roll back together with the
 * move to Results Declared: a failure anywhere leaves Polling Completed and no Result.
 */
export function resultsHooks(masterKey: () => Buffer): HookRegistry {
  return [
    {
      action: "declare_results",
      async run(ctx, info) {
        const document = await buildResultDocument(ctx.tx, {
          electionId: info.electionId,
          declaredAt: ctx.now(),
        });
        const canonical = canonicalResult(document);
        const hash = sha256Hex(canonical);
        const { privateKey } = await loadElectionSigningKey(ctx.tx, info.electionId, masterKey());
        const signature = signTally(privateKey, canonical);

        const inserted = await ctx.tx.query<{ id: string }>(
          `insert into public.results
             (election_id, canonical_json, result_hash, signature, declared_by, declared_at)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [info.electionId, canonical, hash, signature, ctx.actor.userId, ctx.now()],
        );
        const resultId = inserted.rows[0]!.id;

        const totals = new Map<string, Array<{ candidateId: string | null; votes: number }>>();
        for (const post of document.posts) {
          if (post.status === "unopposed" || post.status === "withheld") continue;
          const rows: Array<{ candidateId: string | null; votes: number }> = post.candidates.map(
            (c) => ({ candidateId: c.id, votes: c.votes ?? 0 }),
          );
          if (post.nota !== null) rows.push({ candidateId: null, votes: post.nota });
          totals.set(post.postId, rows);
        }
        for (const [postId, rows] of totals) {
          for (const row of rows) {
            await ctx.tx.query(
              `insert into public.result_items (result_id, post_id, candidate_id, is_nota, booth_id, votes)
               values ($1, $2, $3, $4, null, $5)`,
              [resultId, postId, row.candidateId, row.candidateId === null, row.votes],
            );
          }
        }
        for (const entry of document.booth_wise) {
          for (const row of entry.rows) {
            await ctx.tx.query(
              `insert into public.result_items (result_id, post_id, candidate_id, is_nota, booth_id, votes)
               values ($1, $2, $3, $4, $5, $6)`,
              [
                resultId,
                entry.post_id,
                row.candidate_id,
                row.candidate_id === null,
                entry.booth_id,
                row.votes,
              ],
            );
          }
        }

        return {
          declared_result: {
            result_hash: hash,
            posts_declared: document.posts.filter(
              (p) => p.status === "elected" || p.status === "tie",
            ).length,
            posts_unopposed: document.posts.filter((p) => p.status === "unopposed").length,
            posts_withheld: document.posts.filter((p) => p.status === "withheld").length,
          },
        };
      },
    },
  ];
}

/** `resultsReady`: results are declared once, and only when every booth is Closed or Sealed. */
export const resultsGuards: GuardRegistry = {
  async resultsReady(ctx) {
    const existing = await ctx.tx.query("select 1 from public.results where election_id = $1", [
      ctx.electionId,
    ]);
    if (existing.rows.length > 0) return fail("results were already declared for this Election");
    const open = await ctx.tx.query<{ n: string }>(
      `select count(*) n from public.booth_states s join public.booths b on b.id = s.booth_id
        where b.election_id = $1 and s.state not in ('closed', 'sealed')`,
      [ctx.electionId],
    );
    return Number(open.rows[0]!.n) === 0 ? pass() : fail("a booth is not closed yet");
  },
};
