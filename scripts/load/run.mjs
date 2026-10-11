#!/usr/bin/env node
/**
 * Polling-day load driver. Dependency-free (Node 22 + pg), so it runs from any machine that
 * can reach the deployment and the (test) database.
 *
 *   node scripts/load/run.mjs --config load.json --base https://preview.example \
 *        [--duration 3600] [--interval 10] [--public 500] [--p95 1500] [--out report.json]
 *
 * Each booth repeats, every --interval seconds: a Ballot Session is issued (written straight
 * to the database, standing in for the Presiding Officer pressing Ballot), then the Voting
 * Terminal's real HTTP calls run: GET /terminal/api/ballot, then POST /terminal/api/cast with
 * a valid ballot and an idempotency key (retried on failure like the kiosk). The latency of
 * the cast call is the figure the requirement is about.
 *
 * --public N adds N virtual public viewers polling the status board every 10 s, each with its
 * own X-Forwarded-For so the per-client rate limit treats them as different clients.
 *
 * Needs TEST_ADMIN_DATABASE_URL (to issue sessions and check the totals). Exit code 0 only if
 * p95 is under the threshold, every cast succeeded, and the stored rows equal the casts.
 */
import { randomBytes, randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};

const config = JSON.parse(readFileSync(arg("config", "load.json"), "utf8"));
const base = arg("base", "http://localhost:3000").replace(/\/$/, "");
const durationMs = Number(arg("duration", "60")) * 1000;
const intervalMs = Number(arg("interval", "10")) * 1000;
const publicViewers = Number(arg("public", "0"));
const p95Limit = Number(arg("p95", "1500"));
const reportPath = arg("out", "load-report.json");

const databaseUrl = process.env.TEST_ADMIN_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_ADMIN_DATABASE_URL is required");
const db = new pg.Pool({ connectionString: databaseUrl, max: 10 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (sorted, p) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

function pick(list, count) {
  const pool = [...list];
  const chosen = [];
  while (chosen.length < count) chosen.push(pool.splice(randomInt(pool.length), 1)[0]);
  return chosen;
}

const castLatencies = [];
const fetchLatencies = [];
const publicLatencies = [];
let castOk = 0;
let castFailed = 0;
let retries = 0;
let publicErrors = 0;
let stopped = false;
const stats = { sessions: 0 };

async function oneBallot(booth) {
  const cookie = `evm_terminal=${booth.votingToken}`;
  await db.query(
    `insert into public.ballot_sessions (election_id, booth_id, terminal_id, is_mock, issued_by)
     values ($1, $2, $3, false, $4)`,
    [config.electionId, booth.boothId, booth.terminalId, config.officer],
  );
  stats.sessions += 1;

  let started = performance.now();
  const ballot = await fetch(`${base}/terminal/api/ballot`, { headers: { cookie } });
  fetchLatencies.push(performance.now() - started);
  const pending = await ballot.json();
  if (pending.status !== "pending") throw new Error(`no pending ballot: ${pending.status}`);

  const answers = config.posts.map((post) => ({
    postId: post.id,
    candidateIds: pick(post.candidates, post.seats),
  }));
  const body = JSON.stringify({
    castToken: pending.castToken,
    idempotencyKey: randomBytes(16).toString("hex"),
    answers,
  });

  // Retried with the same key, exactly like the kiosk, until a definitive answer.
  for (let attempt = 0; attempt < 8; attempt++) {
    started = performance.now();
    try {
      const response = await fetch(`${base}/terminal/api/cast`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body,
      });
      const elapsed = performance.now() - started;
      if (response.status === 200) {
        castLatencies.push(elapsed);
        castOk += 1;
        return;
      }
      if (response.status < 500) break; // a definitive refusal
    } catch {
      // network error: retry
    }
    retries += 1;
    await sleep(Math.min(500 * 2 ** attempt, 4000));
  }
  castFailed += 1;
}

async function boothLoop(booth, offset) {
  await sleep(offset);
  while (!stopped) {
    const tick = performance.now();
    try {
      await oneBallot(booth);
    } catch (error) {
      castFailed += 1;
      console.error(`booth ${booth.boothId.slice(0, 8)}: ${error.message}`);
    }
    await sleep(Math.max(0, intervalMs - (performance.now() - tick)));
  }
}

async function viewerLoop(index) {
  const headers = { "x-forwarded-for": `10.${(index >> 8) & 255}.${index & 255}.1` };
  await sleep((index * 10_000) / Math.max(1, publicViewers));
  while (!stopped) {
    const started = performance.now();
    try {
      const response = await fetch(`${base}/public/api/elections/${config.electionId}/status`, {
        headers,
      });
      publicLatencies.push(performance.now() - started);
      if (!response.ok) publicErrors += 1;
      await response.arrayBuffer();
    } catch {
      publicErrors += 1;
    }
    await sleep(10_000);
  }
}

const booths = config.booths.slice(0, Number(arg("booths", String(config.booths.length))));
console.log(
  `Load: ${booths.length} booths, one ballot / ${intervalMs / 1000}s, ${config.posts.length} Posts, ` +
    `${publicViewers} public viewers, ${durationMs / 1000}s against ${base}`,
);

const startedAt = new Date();
const loops = [
  ...booths.map((b, i) => boothLoop(b, (i * intervalMs) / booths.length)),
  ...Array.from({ length: publicViewers }, (_, i) => viewerLoop(i)),
];
await sleep(durationMs);
stopped = true;
await Promise.allSettled(loops);

// Totals: every issued session is cast exactly once, with the expected number of rows.
const { rows: sessionRows } = await db.query(
  `select count(*) filter (where status = 'cast') cast, count(*) filter (where status = 'pending') pending
     from public.ballot_sessions where election_id = $1`,
  [config.electionId],
);
const rowsPerBallot = config.posts.reduce((sum, post) => sum + post.seats, 0);
const { rows: selectionRows } = await db.query(
  "select count(*) n from public.vote_selections where election_id = $1 and not is_mock",
  [config.electionId],
);
const castSessions = Number(sessionRows[0].cast);
const storedRows = Number(selectionRows[0].n);

const sorted = [...castLatencies].sort((a, b) => a - b);
const report = {
  startedAt: startedAt.toISOString(),
  base,
  booths: booths.length,
  posts: config.posts.length,
  intervalSeconds: intervalMs / 1000,
  durationSeconds: durationMs / 1000,
  publicViewers,
  ballotsIssued: stats.sessions,
  castOk,
  castFailed,
  retries,
  castLatencyMs: {
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
    max: Math.round(sorted.at(-1) ?? 0),
  },
  ballotFetchP95Ms: Math.round(
    percentile(
      [...fetchLatencies].sort((a, b) => a - b),
      95,
    ),
  ),
  public: {
    requests: publicLatencies.length,
    errors: publicErrors,
    p95Ms: Math.round(
      percentile(
        [...publicLatencies].sort((a, b) => a - b),
        95,
      ),
    ),
  },
  database: {
    castSessions,
    pendingSessions: Number(sessionRows[0].pending),
    storedSelectionRows: storedRows,
    expectedSelectionRows: castSessions * rowsPerBallot,
  },
};
report.passed =
  report.castLatencyMs.p95 < p95Limit &&
  castFailed === 0 &&
  castOk === castSessions &&
  storedRows === castSessions * rowsPerBallot &&
  report.database.pendingSessions === 0;

writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await db.end();
process.exit(report.passed ? 0 : 1);
