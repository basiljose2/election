import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { Pool } from "pg";
import { assertLocal } from "../support/local-only";
import { E2E_PASSWORD, USERS_FILE, type E2eUsers } from "./users";

config({ path: ".env.test.local", quiet: true });
config({ path: ".env.local", quiet: true });

/** Creates fresh staff accounts for this run (local Supabase stack only). */
export default async function globalSetup() {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const adminDb = process.env.TEST_ADMIN_DATABASE_URL;
  if (!url || !secret || !adminDb) {
    throw new Error("SUPABASE_URL, SUPABASE_SECRET_KEY and TEST_ADMIN_DATABASE_URL are required");
  }
  assertLocal("SUPABASE_URL", url);
  assertLocal("TEST_ADMIN_DATABASE_URL", adminDb);
  const auth = createClient(url, secret, { auth: { persistSession: false } }).auth.admin;
  const db = new Pool({ connectionString: adminDb, max: 1 });

  // All e2e clients share one address; start each run without earlier runs' failed attempts.
  await db.query("delete from public.pairing_attempts");

  const run = Date.now().toString(36);
  const electionId = randomUUID();
  const boothId = randomUUID();
  const spareBoothId = randomUUID();
  const setupElectionId = randomUUID();
  const terminalsElectionId = randomUUID();
  const terminalsBoothId = randomUUID();
  const masterElectionId = randomUUID();
  const masterBoothId = randomUUID();
  const masterPostId = randomUUID();
  const masterCandidateIds = [randomUUID(), randomUUID(), randomUUID()];
  const resultsElectionId = randomUUID();
  const resultsBoothId = randomUUID();
  const resultsBooth2Id = randomUUID();
  const votingElectionId = randomUUID();
  const votingBoothId = randomUUID();
  const votingPresident = {
    id: randomUUID(),
    candidateIds: [randomUUID(), randomUUID(), randomUUID()],
  };
  const votingCouncil = {
    id: randomUUID(),
    candidateIds: [randomUUID(), randomUUID(), randomUUID()],
  };

  for (const [id, name] of [
    [electionId, "E2E election"],
    [setupElectionId, "E2E setup election"],
    [terminalsElectionId, "E2E terminals election"],
    [masterElectionId, "E2E master election"],
  ]) {
    await db.query(
      "insert into public.elections (id, name, polling_date) values ($1, $2, current_date)",
      [id, `${name} ${run}`],
    );
  }
  await db.query(
    "insert into public.booths (id, election_id, name, location) values ($1, $2, 'Terminals booth', 'Hall')",
    [terminalsBoothId, terminalsElectionId],
  );
  // The results fixture: booth 1 holds seeded votes and is closed by scripts/e2e-seed-results.ts;
  // booth 2 (its own Post, no votes) stays Open for the checklist and force-close.
  await db.query(
    "insert into public.elections (id, name, polling_date, nota_enabled) values ($1, $2, current_date, true)",
    [resultsElectionId, `E2E results election ${run}`],
  );
  for (const [id, name] of [
    [resultsBoothId, "Results booth 1"],
    [resultsBooth2Id, "Results booth 2"],
  ]) {
    await db.query(
      "insert into public.booths (id, election_id, name, location) values ($1, $2, $3, 'Hall')",
      [id, resultsElectionId, name],
    );
  }
  const resultsPosts = [
    { name: "President", seats: 1, booth: resultsBoothId, candidates: 3 },
    { name: "Council", seats: 2, booth: resultsBoothId, candidates: 3 },
    { name: "Treasurer", seats: 1, booth: resultsBooth2Id, candidates: 2 },
  ];
  for (const [order, post] of resultsPosts.entries()) {
    const postId = randomUUID();
    await db.query(
      "insert into public.posts (id, election_id, name, display_order, seats) values ($1, $2, $3, $4, $5)",
      [postId, resultsElectionId, post.name, order, post.seats],
    );
    for (let i = 0; i < post.candidates; i++) {
      await db.query(
        "insert into public.candidates (id, election_id, post_id, name, sort_order) values ($1, $2, $3, $4, $5)",
        [randomUUID(), resultsElectionId, postId, `${post.name} candidate ${i}`, i],
      );
    }
    await db.query(
      "insert into public.booth_posts (election_id, booth_id, post_id) values ($1, $2, $3)",
      [resultsElectionId, post.booth, postId],
    );
  }
  // The voting-terminal fixture: two Posts (1 and 2 seats, three Candidates each) and NOTA.
  await db.query(
    "insert into public.elections (id, name, polling_date, nota_enabled) values ($1, $2, current_date, true)",
    [votingElectionId, `E2E voting election ${run}`],
  );
  await db.query(
    "insert into public.booths (id, election_id, name, location) values ($1, $2, 'Voting booth', 'Hall')",
    [votingBoothId, votingElectionId],
  );
  for (const [order, post, name, seats] of [
    [0, votingPresident, "President", 1],
    [1, votingCouncil, "Council", 2],
  ] as const) {
    await db.query(
      "insert into public.posts (id, election_id, name, display_order, seats) values ($1, $2, $3, $4, $5)",
      [post.id, votingElectionId, name, order, seats],
    );
    for (const [i, id] of post.candidateIds.entries()) {
      await db.query(
        "insert into public.candidates (id, election_id, post_id, name, sort_order, symbol_text) values ($1, $2, $3, $4, $5, $6)",
        [id, votingElectionId, post.id, `${name} candidate ${i}`, i, `S${order}${i}`],
      );
    }
    await db.query(
      "insert into public.booth_posts (election_id, booth_id, post_id) values ($1, $2, $3)",
      [votingElectionId, votingBoothId, post.id],
    );
  }
  await db.query(
    "insert into public.booths (id, election_id, name, location) values ($1, $2, 'Master booth', 'Hall')",
    [masterBoothId, masterElectionId],
  );
  await db.query(
    "insert into public.posts (id, election_id, name, display_order, seats) values ($1, $2, 'President', 0, 1)",
    [masterPostId, masterElectionId],
  );
  for (const [i, id] of masterCandidateIds.entries()) {
    await db.query(
      "insert into public.candidates (id, election_id, post_id, name, sort_order) values ($1, $2, $3, $4, $5)",
      [id, masterElectionId, masterPostId, `Master candidate ${i}`, i],
    );
  }
  await db.query(
    "insert into public.booth_posts (election_id, booth_id, post_id) values ($1, $2, $3)",
    [masterElectionId, masterBoothId, masterPostId],
  );
  for (const [id, name] of [
    [boothId, "E2E booth"],
    [spareBoothId, "E2E spare booth"],
  ]) {
    await db.query(
      "insert into public.booths (id, election_id, name, location) values ($1, $2, $3, 'Hall')",
      [id, electionId, name],
    );
  }

  async function staff(
    label: string,
    role: string | null,
    scope: { electionId?: string; boothId?: string },
  ) {
    const email = `e2e-${label}-${run}@example.test`;
    const { data, error } = await auth.createUser({
      email,
      password: E2E_PASSWORD,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
    await db.query("insert into public.staff (user_id, email, display_name) values ($1, $2, $3)", [
      data.user.id,
      email,
      `E2E ${label.toUpperCase()}`,
    ]);
    if (role) {
      await db.query(
        "insert into public.staff_roles (user_id, role, election_id, booth_id) values ($1, $2, $3, $4)",
        [data.user.id, role, scope.electionId ?? null, scope.boothId ?? null],
      );
    }
    return { email, userId: data.user.id };
  }

  const users: E2eUsers = {
    run,
    electionId,
    boothId,
    spareBoothId,
    setup: {
      electionId: setupElectionId,
      superAdmin: await staff("setup-sa", "super_admin", {}),
      returningOfficer: await staff("setup-ro", "returning_officer", {
        electionId: setupElectionId,
      }),
      presidingOfficer1: await staff("setup-po1", null, {}),
      presidingOfficer2: await staff("setup-po2", null, {}),
    },
    terminals: {
      electionId: terminalsElectionId,
      boothId: terminalsBoothId,
      presidingOfficer: await staff("term-po", "presiding_officer", {
        electionId: terminalsElectionId,
        boothId: terminalsBoothId,
      }),
    },
    master: {
      electionId: masterElectionId,
      boothId: masterBoothId,
      postId: masterPostId,
      candidateIds: masterCandidateIds,
      presidingOfficer: await staff("master-po", "presiding_officer", {
        electionId: masterElectionId,
        boothId: masterBoothId,
      }),
      returningOfficer: await staff("master-ro", "returning_officer", {
        electionId: masterElectionId,
      }),
      observer: await staff("master-observer", "observer", { electionId: masterElectionId }),
    },
    results: {
      electionId: resultsElectionId,
      boothId: resultsBoothId,
      booth2Id: resultsBooth2Id,
      returningOfficer: await staff("results-ro", "returning_officer", {
        electionId: resultsElectionId,
      }),
      presidingOfficer1: await staff("results-po1", "presiding_officer", {
        electionId: resultsElectionId,
        boothId: resultsBoothId,
      }),
      presidingOfficer2: await staff("results-po2", "presiding_officer", {
        electionId: resultsElectionId,
        boothId: resultsBooth2Id,
      }),
      observer: await staff("results-observer", "observer", { electionId: resultsElectionId }),
      feedOfficer: await staff("results-feed-ro", "returning_officer", {
        electionId: resultsElectionId,
      }),
    },
    voting: {
      electionId: votingElectionId,
      boothId: votingBoothId,
      president: votingPresident,
      council: votingCouncil,
      presidingOfficer: await staff("voting-po", "presiding_officer", {
        electionId: votingElectionId,
        boothId: votingBoothId,
      }),
    },
    superAdmin: await staff("sa", "super_admin", {}),
    returningOfficer: await staff("ro", "returning_officer", { electionId }),
    presidingOfficer: await staff("po", "presiding_officer", { electionId, boothId }),
  };
  // Terminals can be paired once the election is Frozen (done last: setup tables are Draft-only).
  await db.query(
    "update public.elections set status = 'frozen', frozen_at = now(), freeze_count = 1 where id = $1",
    [terminalsElectionId],
  );

  // The master fixture goes through the real freeze (Ballot Definitions, signing key), then
  // Polling Open. The freeze command is server-only code, so it runs in its own process.
  const votingRo = await staff("voting-ro", "returning_officer", { electionId: votingElectionId });
  for (const [election, officer] of [
    [masterElectionId, users.master.returningOfficer],
    [votingElectionId, votingRo],
  ] as const) {
    execFileSync(
      "npx",
      ["tsx", "--conditions=react-server", "scripts/e2e-freeze.ts", election, officer.userId],
      { stdio: "inherit", shell: process.platform === "win32" },
    );
    await db.query("update public.elections set status = 'polling_open' where id = $1", [election]);
  }
  // Results fixture: freeze for real, open the Election, then seed and close booth 1.
  const resultsRo = users.results.returningOfficer;
  execFileSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "scripts/e2e-freeze.ts",
      resultsElectionId,
      resultsRo.userId,
    ],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  await db.query("update public.elections set status = 'polling_open' where id = $1", [
    resultsElectionId,
  ]);
  execFileSync(
    "npx",
    [
      "tsx",
      "--conditions=react-server",
      "scripts/e2e-seed-results.ts",
      resultsElectionId,
      resultsBoothId,
    ],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  for (const state of ["mock_poll", "mock_cleared", "open"]) {
    await db.query("update public.booth_states set state = $2 where booth_id = $1", [
      resultsBooth2Id,
      state,
    ]);
  }
  await db.end();

  mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
