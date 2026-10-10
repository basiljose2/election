import type { Pool, PoolClient } from "pg";
import { buildAuditExport } from "@/lib/audit/export";
import { sha256Hex } from "@/lib/audit/chain";
import { verifyAuditChain } from "@/lib/audit/verify";
import { loadBoothTally, readBoothDigest, verifyTally, type BoothDigest } from "@/lib/votes/tally";

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Election reconciliation: before results can be declared, prove that what is stored still
 * matches what was signed at close. Every number in the report is a total, a flag or a hash;
 * per-candidate counts never appear (the sealed digest does not return them).
 */

export type BoothCheckId =
  | "booth_closed"
  | "tally_present"
  | "tally_signature"
  | "count_and_root_match"
  | "selection_signatures"
  | "answer_rule"
  | "no_unmapped_selections";

export type ElectionCheckId =
  "audit_chain" | "setup_unchanged" | "ballot_definitions_unchanged" | "no_pending_sessions";

export interface CheckResult<Id extends string> {
  check: Id;
  passed: boolean;
  /** A short, choice-free explanation when the check failed. */
  detail?: string;
}

export interface BoothReport {
  boothId: string;
  boothName: string;
  state: string;
  ballotsCast: number;
  ballotsCancelled: number;
  tallyHash: string | null;
  /** Ballot answers per contested Post mapped to the booth (never per candidate). */
  answers: Array<{ postId: string; postName: string; answers: number }>;
  checks: Array<CheckResult<BoothCheckId>>;
  passed: boolean;
}

export interface PostOutcome {
  postId: string;
  postName: string;
  status: "pass" | "failed";
  /** Booths whose failure (or an election-wide failure) withheld this Post. */
  reasons: string[];
}

export interface ReconciliationReport {
  version: 1;
  electionId: string;
  ranAt: string;
  electionChecks: Array<CheckResult<ElectionCheckId>>;
  electionChecksPassed: boolean;
  booths: BoothReport[];
  posts: PostOutcome[];
}

interface DefinitionPost {
  post_id: string;
  name: string;
  seats: number;
}

const pass = <Id extends string>(check: Id): CheckResult<Id> => ({ check, passed: true });
const fail = <Id extends string>(check: Id, detail: string): CheckResult<Id> => ({
  check,
  passed: false,
  detail,
});

async function electionChecks(
  db: Queryable,
  electionId: string,
): Promise<Array<CheckResult<ElectionCheckId>>> {
  const results: Array<CheckResult<ElectionCheckId>> = [];

  // The Election's chain and the system chain it was recorded alongside.
  const chains = [await buildAuditExport(db, electionId), await buildAuditExport(db, null)];
  const broken = chains
    .map((doc) => verifyAuditChain(doc))
    .find((v): v is Extract<typeof v, { ok: false }> => !v.ok);
  results.push(
    broken
      ? fail("audit_chain", `${broken.reason} (event ${broken.seq ?? "?"})`)
      : pass("audit_chain"),
  );

  // Setup Hash and Ballot Definitions against the Audit Event written when they were frozen.
  const snapshot = await db.query<{
    freeze_no: number;
    canonical_json: string;
    setup_hash: string;
  }>(
    `select s.freeze_no, s.canonical_json, s.setup_hash
       from public.setup_snapshots s
       join public.elections e on e.id = s.election_id and e.freeze_count = s.freeze_no
      where s.election_id = $1`,
    [electionId],
  );
  const snap = snapshot.rows[0];
  const frozen = await db.query<{ payload: { after?: { setup_hash?: string }; detail?: unknown } }>(
    `select payload from public.audit_events
      where chain_key = $1::uuid and payload->>'event_type' = 'election.frozen'
      order by seq desc limit 1`,
    [electionId],
  );
  const anchor = frozen.rows[0]?.payload;
  if (!snap) {
    results.push(fail("setup_unchanged", "no frozen setup snapshot"));
    results.push(fail("ballot_definitions_unchanged", "no frozen setup snapshot"));
  } else {
    const recomputed = sha256Hex(snap.canonical_json);
    results.push(
      recomputed === snap.setup_hash && anchor?.after?.setup_hash === snap.setup_hash
        ? pass("setup_unchanged")
        : fail("setup_unchanged", "the stored setup no longer matches its Setup Hash"),
    );

    const definitions = await db.query<{
      booth_id: string;
      canonical_json: string;
      definition_hash: string;
    }>(
      `select booth_id, canonical_json, definition_hash from public.ballot_definitions
        where election_id = $1 and freeze_no = $2`,
      [electionId, snap.freeze_no],
    );
    const anchored = new Map(
      (
        (
          anchor?.detail as {
            booth_definitions?: Array<{ booth_id: string; definition_hash: string }>;
          }
        )?.booth_definitions ?? []
      ).map((d) => [d.booth_id, d.definition_hash]),
    );
    const drifted = definitions.rows.filter((d) => {
      const parsed = JSON.parse(d.canonical_json) as { setup_hash?: string };
      return (
        sha256Hex(d.canonical_json) !== d.definition_hash ||
        anchored.get(d.booth_id) !== d.definition_hash ||
        parsed.setup_hash !== snap.setup_hash
      );
    });
    results.push(
      drifted.length === 0 && definitions.rows.length === anchored.size
        ? pass("ballot_definitions_unchanged")
        : fail(
            "ballot_definitions_unchanged",
            `${drifted.length || "a"} Ballot Definition(s) differ from the frozen setup`,
          ),
    );
  }

  const pending = await db.query<{ n: string }>(
    "select count(*) n from public.ballot_sessions where election_id = $1 and status = 'pending'",
    [electionId],
  );
  const pendingCount = Number(pending.rows[0]!.n);
  results.push(
    pendingCount === 0
      ? pass("no_pending_sessions")
      : fail("no_pending_sessions", `${pendingCount} Ballot Session(s) still pending`),
  );
  return results;
}

async function boothReport(
  db: Queryable,
  booth: { id: string; name: string; state: string },
  publicKey: string | null,
  definitionPosts: DefinitionPost[],
): Promise<BoothReport> {
  const checks: Array<CheckResult<BoothCheckId>> = [];
  const counters = await db.query<{ ballots_cast: string; ballots_cancelled: string }>(
    "select ballots_cast, ballots_cancelled from public.booth_counters where booth_id = $1",
    [booth.id],
  );
  const counter = counters.rows[0]!;
  const report: BoothReport = {
    boothId: booth.id,
    boothName: booth.name,
    state: booth.state,
    ballotsCast: Number(counter.ballots_cast),
    ballotsCancelled: Number(counter.ballots_cancelled),
    tallyHash: null,
    answers: [],
    checks,
    passed: false,
  };

  const closed = booth.state === "closed" || booth.state === "sealed";
  checks.push(closed ? pass("booth_closed") : fail("booth_closed", `the booth is ${booth.state}`));
  const tally = await loadBoothTally(db, booth.id);
  checks.push(tally ? pass("tally_present") : fail("tally_present", "no Booth Tally exists"));
  if (tally) report.tallyHash = tally.tallyHash;

  if (tally) {
    checks.push(
      publicKey && verifyTally(publicKey, tally.canonicalJson, tally.signature)
        ? pass("tally_signature")
        : fail("tally_signature", "the Booth Tally signature does not verify"),
    );
  }

  let digest: BoothDigest | null = null;
  if (closed) digest = await readBoothDigest(db, booth.id);

  if (digest) {
    const names = new Map(definitionPosts.map((p) => [p.post_id, p.name]));
    report.answers = digest.posts.map((p) => ({
      postId: p.post_id,
      postName: names.get(p.post_id) ?? p.post_id,
      answers: p.answers,
    }));
    if (tally) {
      const same =
        digest.selection_rows === tally.content.selection_rows &&
        digest.merkle_root === tally.content.merkle_root;
      checks.push(
        same
          ? pass("count_and_root_match")
          : fail(
              "count_and_root_match",
              "the stored Vote Selections no longer match the Booth Tally (count or Merkle root)",
            ),
      );
    }
    checks.push(
      digest.bad_signatures === 0
        ? pass("selection_signatures")
        : fail(
            "selection_signatures",
            `${digest.bad_signatures} Vote Selection signature(s) invalid`,
          ),
    );
    const cast = tally?.content.ballots_cast ?? report.ballotsCast;
    const wrong = digest.posts.filter((p) => !p.divisible || p.answers !== cast);
    const counterMismatch = tally ? tally.content.ballots_cast !== report.ballotsCast : false;
    checks.push(
      wrong.length === 0 && !counterMismatch
        ? pass("answer_rule")
        : fail(
            "answer_rule",
            counterMismatch
              ? "ballots cast differ from the Booth Tally"
              : `answers differ from ballots cast for ${wrong.length} Post(s)`,
          ),
    );
    checks.push(
      digest.unmapped_rows === 0
        ? pass("no_unmapped_selections")
        : fail("no_unmapped_selections", "a Vote Selection exists for a Post not mapped here"),
    );
  } else {
    for (const check of [
      "count_and_root_match",
      "selection_signatures",
      "answer_rule",
      "no_unmapped_selections",
    ] as const) {
      checks.push(fail(check, "the booth is not closed"));
    }
  }

  report.passed = checks.every((c) => c.passed);
  return report;
}

/** Runs every check. Reads only; the caller stores the run and writes the Audit Event. */
export async function runReconciliation(
  db: Queryable,
  input: { electionId: string; now: Date },
): Promise<ReconciliationReport> {
  const { electionId } = input;
  const election = await electionChecks(db, electionId);

  const key = await db.query<{ public_key: string }>(
    "select public_key from public.election_signing_keys where election_id = $1",
    [electionId],
  );
  const publicKey = key.rows[0]?.public_key ?? null;

  const booths = await db.query<{ id: string; name: string; state: string }>(
    `select b.id, b.name, s.state::text as state
       from public.booths b join public.booth_states s on s.booth_id = b.id
      where b.election_id = $1 order by b.name, b.id`,
    [electionId],
  );
  const definitions = await db.query<{ booth_id: string; canonical_json: string }>(
    `select d.booth_id, d.canonical_json
       from public.ballot_definitions d
       join public.elections e on e.id = d.election_id and e.freeze_count = d.freeze_no
      where d.election_id = $1`,
    [electionId],
  );
  const postsByBooth = new Map<string, DefinitionPost[]>(
    definitions.rows.map((d) => [
      d.booth_id,
      (JSON.parse(d.canonical_json) as { posts: DefinitionPost[] }).posts,
    ]),
  );

  const reports: BoothReport[] = [];
  for (const booth of booths.rows) {
    reports.push(await boothReport(db, booth, publicKey, postsByBooth.get(booth.id) ?? []));
  }

  // A Post passes only if every booth mapped to it passes and the election-wide checks pass.
  const electionOk = election.every((c) => c.passed);
  const posts = new Map<string, PostOutcome>();
  for (const [boothId, list] of postsByBooth) {
    const booth = reports.find((r) => r.boothId === boothId);
    for (const post of list) {
      const outcome = posts.get(post.post_id) ?? {
        postId: post.post_id,
        postName: post.name,
        status: "pass" as const,
        reasons: [],
      };
      if (booth && !booth.passed) {
        outcome.status = "failed";
        outcome.reasons.push(`booth ${booth.boothName} failed its checks`);
      }
      posts.set(post.post_id, outcome);
    }
  }
  for (const outcome of posts.values()) {
    if (!electionOk) {
      outcome.status = "failed";
      outcome.reasons.push("an election-wide check failed");
    }
  }

  return {
    version: 1,
    electionId,
    ranAt: input.now.toISOString(),
    electionChecks: election,
    electionChecksPassed: electionOk,
    booths: reports,
    posts: [...posts.values()].sort((a, b) => a.postName.localeCompare(b.postName)),
  };
}

export async function storeReconciliation(
  db: Queryable,
  report: ReconciliationReport,
  runBy: string | null,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.reconciliation_runs (election_id, run_by, run_at, election_checks_passed, report)
     values ($1, $2, $3, $4, $5::jsonb) returning id`,
    [report.electionId, runBy, report.ranAt, report.electionChecksPassed, JSON.stringify(report)],
  );
  return rows[0]!.id;
}

export async function latestReconciliation(
  db: Queryable,
  electionId: string,
): Promise<ReconciliationReport | null> {
  const { rows } = await db.query<{ report: ReconciliationReport }>(
    `select report from public.reconciliation_runs
      where election_id = $1 order by run_at desc, id desc limit 1`,
    [electionId],
  );
  return rows[0]?.report ?? null;
}

/**
 * For result declaration: did this Post pass the latest reconciliation? False when there is no
 * run yet, so a Post can never be declared on an election that was not reconciled.
 */
export async function reconciliationPassed(
  db: Queryable,
  electionId: string,
  postId: string,
): Promise<boolean> {
  const report = await latestReconciliation(db, electionId);
  return report?.posts.find((p) => p.postId === postId)?.status === "pass";
}

/** The report as an Audit Event detail: check outcomes and ids only. */
export function reportAuditDetail(report: ReconciliationReport) {
  return {
    election_checks: report.electionChecks.map((c) => ({ check: c.check, passed: c.passed })),
    booths: report.booths.map((b) => ({
      booth_id: b.boothId,
      tally_hash: b.tallyHash,
      passed: b.passed,
      checks: b.checks.map((c) => ({ check: c.check, passed: c.passed })),
    })),
    posts: report.posts.map((p) => ({ post_id: p.postId, status: p.status })),
  };
}
