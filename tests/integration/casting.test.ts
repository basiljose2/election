import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import type { Actor } from "@/lib/auth/roles";
import { createBallotCommands } from "@/lib/commands/ballots";
import { CommandError } from "@/lib/commands/errors";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { createAppLifecycle } from "@/lib/lifecycle/app";
import { setLogSink, type LogRecord } from "@/lib/log";
import { MemorySignalBus } from "@/lib/signals/memory";
import type { AuthenticatedTerminal } from "@/lib/terminals/credentials";
import { getTerminalState } from "@/lib/terminals/state";
import { castBallot, fetchPendingBallot, type CastingDeps } from "@/lib/votes/casting";
import { decryptPrivateKey, parseMasterKey, type KeyEnvelope } from "@/lib/votes/keys";
import { getMockCounts } from "@/lib/votes/mock-counts";
import { getElectionTurnout } from "@/lib/votes/turnout";
import { verifySelection, type SelectionContent } from "@/lib/votes/signing";
import { adminPool, appPool, auditEvents } from "../support/fixtures";
import { buildVotingWorld, validAnswers, type VotingWorld } from "../support/voting-world";

const app = appPool();
const admin = adminPool();
const bus = new MemorySignalBus();
const ballots = createBallotCommands(bus);
const lifecycle = createAppLifecycle(bus);
const masterKey = parseMasterKey(process.env.VOTE_SIGNING_MASTER_KEY);

let clock = new Date();
const now = () => clock;

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const gw = (actor: Actor): Partial<GatewayDeps> => ({
  db: app,
  now,
  authenticate: async () => actor,
  appendAudit: appendAuditEvent,
});

const castingDeps = (overrides: Partial<CastingDeps> = {}): CastingDeps => ({
  db: app,
  now,
  appendAudit: appendAuditEvent,
  publisher: bus,
  masterKey,
  ...overrides,
});

async function expectError(promise: Promise<unknown>, code: string, message?: RegExp) {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) =>
      e instanceof CommandError && e.code === code && (!message || message.test(e.message)),
  );
}

const issue = (w: VotingWorld, actor: Actor = w.po, masterToken = w.masterToken) =>
  executeCommand(ballots.issueBallotSession, { boothId: w.boothId, masterToken }, gw(actor));

/** Issues a ballot and has the bound Voting Terminal fetch it. */
async function issued(w: VotingWorld) {
  await issue(w);
  const pending = await fetchPendingBallot({ db: app }, w.voting);
  if (pending.status !== "pending") throw new Error(`no pending ballot: ${pending.status}`);
  return pending;
}

const idemKey = () => randomUUID().replace(/-/g, "");

const rowCount = async (boothId: string, mock?: boolean) =>
  Number(
    (
      await admin.query(
        "select count(*) n from public.vote_selections where booth_id = $1 and ($2::boolean is null or is_mock = $2)",
        [boothId, mock ?? null],
      )
    ).rows[0].n,
  );
const counters = async (boothId: string) =>
  (
    await admin.query(
      "select ballots_cast::int cast, ballots_cancelled::int cancelled, mock_round from public.booth_counters where booth_id = $1",
      [boothId],
    )
  ).rows[0] as { cast: number; cancelled: number; mock_round: number };

// ----------------------------------------------------------------------------- issuing (3.1)

describe("issue a Ballot Session", () => {
  beforeEach(() => {
    clock = new Date();
  });

  it("creates a pending real session bound to the Voting Terminal, audited and signalled", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    bus.published.length = 0;
    const { sessionId, isMock } = await issue(w);
    expect(isMock).toBe(false);

    const { rows } = await admin.query(
      "select status, is_mock, terminal_id, issued_by from public.ballot_sessions where id = $1",
      [sessionId],
    );
    expect(rows[0]).toMatchObject({
      status: "pending",
      is_mock: false,
      terminal_id: w.voting.id,
      issued_by: w.po.userId,
    });
    expect(bus.published.map((p) => p.signal.type)).toEqual(["ballot-enabled"]);
    const events = await auditEvents(app, {
      electionId: w.electionId,
      eventType: "ballot.session_issued",
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ target: { type: "ballot_session", id: sessionId } });
  });

  it("marks the session mock if and only if the booth is in Mock Poll", async () => {
    const w = await buildVotingWorld(admin, { booth: "mock_poll", election: "frozen", now: clock });
    const { sessionId, isMock } = await issue(w);
    expect(isMock).toBe(true);
    const { rows } = await admin.query(
      "select is_mock, mock_round from public.ballot_sessions where id = $1",
      [sessionId],
    );
    expect(rows[0]).toEqual({ is_mock: true, mock_round: 1 });
  });

  it("rejects a second ballot while one is pending", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    await issue(w);
    await expectError(issue(w), "lifecycle", /already pending/);
  });

  it("rejects when the booth is not Open or in Mock Poll", async () => {
    for (const booth of ["setup", "mock_cleared"] as const) {
      const w = await buildVotingWorld(admin, { booth, now: clock });
      await expectError(issue(w), "lifecycle", /Open or in a mock poll/);
    }
    // A Closed booth rejects every terminal credential, so the Master Terminal itself is refused.
    const closed = await buildVotingWorld(admin, { booth: "closed", now: clock });
    await expectError(issue(closed), "forbidden");
    expect(
      Number(
        (
          await admin.query("select count(*) n from public.ballot_sessions where booth_id = $1", [
            closed.boothId,
          ])
        ).rows[0].n,
      ),
    ).toBe(0);
  });

  it("rejects a real ballot while the Election is not Polling Open", async () => {
    const w = await buildVotingWorld(admin, { election: "frozen", booth: "open", now: clock });
    await expectError(issue(w), "lifecycle", /not Polling Open/);
  });

  it("rejects while the Voting Terminal is offline or missing", async () => {
    const offline = await buildVotingWorld(admin, { online: false, now: clock });
    await expectError(issue(offline), "lifecycle", /offline/);

    const stale = await buildVotingWorld(admin, { now: clock });
    clock = new Date(clock.getTime() + 60_000); // 60 s since its last heartbeat
    await expectError(issue(stale), "lifecycle", /offline/);

    const none = await buildVotingWorld(admin, { now: new Date() });
    await admin.query(
      "update public.terminals set status = 'revoked', revoked_at = now(), revoked_reason = 't' where id = $1",
      [none.voting.id],
    );
    await expectError(issue(none), "lifecycle", /No Voting Terminal/);
  });

  it("needs the booth's Master Terminal credential as well as the Presiding Officer login", async () => {
    const a = await buildVotingWorld(admin, { now: clock });
    const b = await buildVotingWorld(admin, { now: clock });
    await expectError(issue(a, a.po, b.masterToken), "forbidden"); // another booth's device
    await expectError(issue(a, a.po, "not-a-token"), "forbidden");
    await expectError(issue(a, b.po), "forbidden"); // another booth's officer
    await expectError(issue(a, a.ro), "forbidden"); // not a Presiding Officer
    expect(
      Number(
        (
          await admin.query("select count(*) n from public.ballot_sessions where booth_id = $1", [
            a.boothId,
          ])
        ).rows[0].n,
      ),
    ).toBe(0);
  });
});

// ------------------------------------------------------------------------ fetching (3.2)

describe("pending ballot fetch", () => {
  beforeEach(() => {
    clock = new Date();
  });

  it("gives the bound Voting Terminal the Ballot Definition and a cast token", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    expect(await fetchPendingBallot({ db: app }, w.voting)).toEqual({ status: "none" });

    await issue(w);
    const pending = await fetchPendingBallot({ db: app }, w.voting);
    expect(pending.status).toBe("pending");
    if (pending.status !== "pending") return;
    expect(pending.castToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.ballotDefinition.posts.map((p) => p.post_id)).toEqual([
      w.presidentId,
      w.councilId,
    ]);
    expect(pending.ballotDefinition.nota_enabled).toBe(true);
    expect(pending.isMock).toBe(false);

    // Only the hash of the token is stored.
    const { rows } = await admin.query(
      "select cast_token_hash from public.ballot_sessions where booth_id = $1",
      [w.boothId],
    );
    expect(JSON.stringify(rows)).not.toContain(pending.castToken);
  });

  it("refuses any other device (negative tests)", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const other = await buildVotingWorld(admin, { now: clock });
    await issue(w);

    // A different terminal of the same booth, a Master Terminal, and a terminal of another booth.
    const replacement: AuthenticatedTerminal = { ...w.voting, id: randomUUID() };
    expect(await fetchPendingBallot({ db: app }, replacement)).toEqual({ status: "forbidden" });
    expect(await fetchPendingBallot({ db: app }, w.masterTerminal)).toEqual({
      status: "forbidden",
    });
    expect(await fetchPendingBallot({ db: app }, other.voting)).toEqual({ status: "none" });
  });

  it("only the latest token casts (each fetch replaces it)", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    await issue(w);
    const first = await fetchPendingBallot({ db: app }, w.voting);
    const second = await fetchPendingBallot({ db: app }, w.voting);
    if (first.status !== "pending" || second.status !== "pending") throw new Error("unexpected");
    expect(second.castToken).not.toBe(first.castToken);
    expect(
      await castBallot(castingDeps(), w.voting, {
        castToken: first.castToken,
        idempotencyKey: idemKey(),
        answers: validAnswers(w),
      }),
    ).toEqual({ status: "rejected", reason: "bad_token" });
    expect(await rowCount(w.boothId)).toBe(0);
  });
});

// ------------------------------------------------------------------------- cancelling (3.3)

describe("cancel a pending Ballot Session", () => {
  beforeEach(() => {
    clock = new Date();
  });

  it("stores nothing, counts the cancellation, audits it and refuses a later cast", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    bus.published.length = 0;
    const { sessionId } = await executeCommand(
      ballots.cancelBallotSession,
      { boothId: w.boothId, masterToken: w.masterToken, reason: "voter_left", note: "walked away" },
      gw(w.po),
    );

    expect(await counters(w.boothId)).toMatchObject({ cast: 0, cancelled: 1 });
    expect(await rowCount(w.boothId)).toBe(0);
    expect(bus.published.map((p) => p.signal.type)).toEqual(["ballot-cancelled"]);
    const [event] = await auditEvents(app, {
      electionId: w.electionId,
      eventType: "ballot.session_cancelled",
    });
    expect(event!.payload).toMatchObject({
      target: { id: sessionId },
      detail: { reason: "voter_left", note: "walked away" },
    });

    // Cast after cancel is rejected and stores nothing.
    expect(
      await castBallot(castingDeps(), w.voting, {
        castToken: pending.castToken,
        idempotencyKey: idemKey(),
        answers: validAnswers(w),
      }),
    ).toEqual({ status: "rejected", reason: "cancelled" });
    expect(await rowCount(w.boothId)).toBe(0);
    expect(await counters(w.boothId)).toMatchObject({ cast: 0 });

    // The terminal no longer sees a ballot.
    expect(await fetchPendingBallot({ db: app }, w.voting)).toEqual({ status: "none" });
  });

  it("takes a reason from the fixed list, needs a pending ballot and the master credential", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const cancel = (reason: string, token = w.masterToken, actor = w.po) =>
      executeCommand(
        ballots.cancelBallotSession,
        { boothId: w.boothId, masterToken: token, reason },
        gw(actor),
      );
    await expectError(cancel("voter_left"), "lifecycle", /no pending ballot/);
    await issue(w);
    await expectError(cancel("because"), "invalid_input");
    await expectError(cancel("voter_left", "bad"), "forbidden");
    await expectError(cancel("voter_left", w.masterToken, w.ro), "forbidden");
    await cancel("terminal_fault");
    expect(await counters(w.boothId)).toMatchObject({ cancelled: 1 });
  });
});

// ----------------------------------------------------------------------- casting (4.2–4.5)

describe("casting", () => {
  beforeEach(() => {
    clock = new Date();
  });

  it("stores one Vote Selection per choice, counts the ballot and audits without choices", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    bus.published.length = 0;
    const answers = validAnswers(w, { president: 1, council: [0, 2] });

    const result = await castBallot(castingDeps(), w.voting, {
      castToken: pending.castToken,
      idempotencyKey: idemKey(),
      answers,
    });
    expect(result).toEqual({ status: "cast" });

    const stored = await admin.query<{
      post_id: string;
      candidate_id: string | null;
      is_mock: boolean;
    }>("select post_id, candidate_id, is_mock from public.vote_selections where booth_id = $1", [
      w.boothId,
    ]);
    expect(stored.rows).toHaveLength(3);
    expect(stored.rows.every((r) => r.is_mock === false)).toBe(true);
    expect(stored.rows.map((r) => r.candidate_id).sort()).toEqual(
      [w.presidents[1], w.councillors[0], w.councillors[2]].sort(),
    );
    expect(await counters(w.boothId)).toMatchObject({ cast: 1 });
    const session = await admin.query(
      "select status from public.ballot_sessions where booth_id = $1",
      [w.boothId],
    );
    expect(session.rows[0].status).toBe("cast");

    // Audit event and signal carry no choices.
    const events = await auditEvents(app, { electionId: w.electionId, eventType: "ballot.cast" });
    expect(events).toHaveLength(1);
    const text = JSON.stringify(events) + JSON.stringify(bus.published);
    for (const id of [...w.presidents, ...w.councillors]) expect(text).not.toContain(id);
    expect(bus.published.map((p) => p.signal)).toEqual([
      { type: "ballot-cast", version: expect.any(Number) },
    ]);
  });

  it("leaves a session pending after an invalid cast, storing nothing", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    const bad = await castBallot(castingDeps(), w.voting, {
      castToken: pending.castToken,
      idempotencyKey: idemKey(),
      answers: [{ postId: w.presidentId, candidateIds: [w.presidents[0]] }],
    });
    expect(bad).toEqual({
      status: "invalid",
      issues: [{ code: "missing_post", postId: w.councilId }],
    });
    expect(await rowCount(w.boothId)).toBe(0);
    expect(await counters(w.boothId)).toMatchObject({ cast: 0 });
    // Still pending: the voter can correct the ballot and cast it.
    expect(
      await castBallot(castingDeps(), w.voting, {
        castToken: pending.castToken,
        idempotencyKey: idemKey(),
        answers: validAnswers(w),
      }),
    ).toEqual({ status: "cast" });
  });

  it("rolls back completely when storing a selection fails part-way (fault injection)", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    bus.published.length = 0;
    const input = {
      castToken: pending.castToken,
      idempotencyKey: idemKey(),
      answers: validAnswers(w),
    };
    await expect(
      castBallot(
        castingDeps({
          afterSelectionInsert: (index) => {
            if (index === 1) throw new Error("injected storage failure");
          },
        }),
        w.voting,
        input,
      ),
    ).rejects.toThrow("injected storage failure");

    expect(await rowCount(w.boothId)).toBe(0); // no partial ballot
    expect(await counters(w.boothId)).toMatchObject({ cast: 0 });
    const session = await admin.query(
      "select status from public.ballot_sessions where booth_id = $1",
      [w.boothId],
    );
    expect(session.rows[0].status).toBe("pending");
    expect(bus.published).toEqual([]);
    expect(await auditEvents(app, { electionId: w.electionId, eventType: "ballot.cast" })).toEqual(
      [],
    );

    // The retry succeeds.
    expect(await castBallot(castingDeps(), w.voting, input)).toEqual({ status: "cast" });
    expect(await rowCount(w.boothId)).toBe(3);
  });

  it("a retry with the same idempotency key returns success with one stored ballot", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    const input = {
      castToken: pending.castToken,
      idempotencyKey: idemKey(),
      answers: validAnswers(w),
    };
    expect(await castBallot(castingDeps(), w.voting, input)).toEqual({ status: "cast" });
    bus.published.length = 0;
    expect(await castBallot(castingDeps(), w.voting, input)).toEqual({ status: "cast" });
    expect(await rowCount(w.boothId)).toBe(3);
    expect(await counters(w.boothId)).toMatchObject({ cast: 1 });
    expect(bus.published).toEqual([]); // nothing new to signal
  });

  it("a different key for a cast session is rejected", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    const first = {
      castToken: pending.castToken,
      idempotencyKey: idemKey(),
      answers: validAnswers(w),
    };
    await castBallot(castingDeps(), w.voting, first);
    expect(
      await castBallot(castingDeps(), w.voting, { ...first, idempotencyKey: idemKey() }),
    ).toEqual({ status: "rejected", reason: "already_finished" });
    expect(await rowCount(w.boothId)).toBe(3);
  });

  it("20 parallel casts of one session store exactly one ballot", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        castBallot(castingDeps(), w.voting, {
          castToken: pending.castToken,
          idempotencyKey: idemKey(), // all different
          answers: validAnswers(w),
        }),
      ),
    );
    expect(results.filter((r) => r.status === "cast")).toHaveLength(1);
    expect(
      results.filter((r) => r.status === "rejected" && r.reason === "already_finished"),
    ).toHaveLength(19);
    expect(await rowCount(w.boothId)).toBe(3);
    expect(await counters(w.boothId)).toMatchObject({ cast: 1 });
  });

  it("20 parallel retries with one key also store exactly one ballot", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    const key = idemKey();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        castBallot(castingDeps(), w.voting, {
          castToken: pending.castToken,
          idempotencyKey: key,
          answers: validAnswers(w),
        }),
      ),
    );
    expect(results.every((r) => r.status === "cast")).toBe(true);
    expect(await rowCount(w.boothId)).toBe(3);
    expect(await counters(w.boothId)).toMatchObject({ cast: 1 });
  });

  it("refuses another terminal's cast and a malformed request", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    const intruder: AuthenticatedTerminal = { ...w.voting, id: randomUUID() };
    const base = {
      castToken: pending.castToken,
      idempotencyKey: idemKey(),
      answers: validAnswers(w),
    };
    expect(await castBallot(castingDeps(), intruder, base)).toEqual({
      status: "rejected",
      reason: "wrong_terminal",
    });
    expect(await castBallot(castingDeps(), w.masterTerminal, base)).toEqual({
      status: "rejected",
      reason: "bad_request",
    });
    for (const bad of [
      { ...base, castToken: "short" },
      { ...base, idempotencyKey: "tooshort" },
      { ...base, idempotencyKey: undefined },
    ]) {
      expect(await castBallot(castingDeps(), w.voting, bad)).toEqual({
        status: "rejected",
        reason: "bad_request",
      });
    }
    expect(await rowCount(w.boothId)).toBe(0);
  });

  it("responses, signals and terminal state never contain choices (contract snapshot)", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    bus.published.length = 0;
    const result = await castBallot(castingDeps(), w.voting, {
      castToken: pending.castToken,
      idempotencyKey: idemKey(),
      answers: validAnswers(w),
    });
    expect(result).toStrictEqual({ status: "cast" });
    expect(bus.published).toStrictEqual([
      { boothId: w.boothId, signal: { type: "ballot-cast", version: expect.any(Number) } },
    ]);
    const state = await getTerminalState({ db: app, now, appendAudit: appendAuditEvent }, w.voting);
    expect(Object.keys(state).sort()).toEqual(["ballotPending", "boothState", "role", "version"]);
    const everything = JSON.stringify([result, bus.published, state]);
    for (const id of [...w.presidents, ...w.councillors]) expect(everything).not.toContain(id);
  });
});

// -------------------------------------------------------------------------- turnout

describe("live booth counters", () => {
  it("are updated in the cast and cancel transactions and readable by the right roles", async () => {
    clock = new Date();
    const w = await buildVotingWorld(admin, { now: clock });
    const first = await issued(w);
    await castBallot(castingDeps(), w.voting, {
      castToken: first.castToken,
      idempotencyKey: idemKey(),
      answers: validAnswers(w),
    });
    await issued(w);
    await executeCommand(
      ballots.cancelBallotSession,
      { boothId: w.boothId, masterToken: w.masterToken, reason: "voter_refused" },
      gw(w.po),
    );

    // The Master Terminal's next state fetch shows both counts.
    const state = await getTerminalState(
      { db: app, now, appendAudit: appendAuditEvent },
      w.masterTerminal,
    );
    expect(state).toMatchObject({ ballotsCast: 1, ballotsCancelled: 1 });

    // The Returning Officer sees booth turnout; no choice data is in it.
    const turnout = await getElectionTurnout(app, w.ro, w.electionId);
    expect(turnout).toEqual([
      { boothId: w.boothId, name: "Main Hall", state: "open", ballotsCast: 1, ballotsCancelled: 1 },
    ]);

    // An officer of another Election is refused.
    const other = await buildVotingWorld(admin, { now: clock });
    await expectError(getElectionTurnout(app, other.ro, w.electionId), "forbidden");
  });
});

// ------------------------------------------------------------------- signatures and keys (2.1)

describe("election signing keys", () => {
  beforeEach(() => {
    clock = new Date();
  });

  it("are created at freeze, published in the Setup, and sign every stored selection", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const snapshot = await admin.query<{ canonical_json: string }>(
      "select canonical_json from public.setup_snapshots where election_id = $1",
      [w.electionId],
    );
    const setup = JSON.parse(snapshot.rows[0]!.canonical_json) as {
      signing: { algorithm: string; public_key: string };
    };
    expect(setup.signing).toEqual({ algorithm: "Ed25519", public_key: w.publicKey });

    const pending = await issued(w);
    await castBallot(castingDeps(), w.voting, {
      castToken: pending.castToken,
      idempotencyKey: idemKey(),
      answers: validAnswers(w, { president: "nota" }),
    });
    const rows = await admin.query<SelectionContent & { signature: string }>(
      `select id, election_id, booth_id, post_id, candidate_id, is_nota, is_mock, mock_round, signature
         from public.vote_selections where booth_id = $1`,
      [w.boothId],
    );
    expect(rows.rows).toHaveLength(3);
    for (const row of rows.rows) {
      const { signature, ...content } = row;
      expect(verifySelection(setup.signing.public_key, content, signature)).toBe(true);
    }

    // A row inserted outside the cast process does not verify.
    const forged = { ...rows.rows[0]!, id: randomUUID() };
    const { signature: stolen, ...forgedContent } = forged;
    expect(verifySelection(setup.signing.public_key, forgedContent, stolen)).toBe(false);
  });

  it("keeps the private key out of every stored and published artefact", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    await castBallot(castingDeps(), w.voting, {
      castToken: pending.castToken,
      idempotencyKey: idemKey(),
      answers: validAnswers(w),
    });

    const { rows } = await admin.query<{ private_key_envelope: KeyEnvelope }>(
      "select private_key_envelope from public.election_signing_keys where election_id = $1",
      [w.electionId],
    );
    const envelope = rows[0]!.private_key_envelope;
    const der = decryptPrivateKey(masterKey, w.electionId, envelope);
    const secrets = [
      der.toString("base64"),
      der.toString("base64url"),
      der.toString("hex"),
      envelope.ciphertext,
    ];

    const published = [
      (
        await admin.query(
          "select canonical_json from public.setup_snapshots where election_id = $1",
          [w.electionId],
        )
      ).rows,
      (
        await admin.query(
          "select canonical_json from public.ballot_definitions where election_id = $1",
          [w.electionId],
        )
      ).rows,
      await auditEvents(app, { electionId: w.electionId }),
      (
        await admin.query("select * from public.ballot_sessions where election_id = $1", [
          w.electionId,
        ])
      ).rows,
    ];
    const text = JSON.stringify(published);
    for (const secret of secrets) expect(text).not.toContain(secret);

    // An envelope cannot be unwrapped with another key, or moved to another election.
    expect(() => decryptPrivateKey(Buffer.alloc(32, 1), w.electionId, envelope)).toThrow();
    expect(() => decryptPrivateKey(masterKey, randomUUID(), envelope)).toThrow();
  });

  it("freeze fails closed without a master key", async () => {
    const saved = process.env.VOTE_SIGNING_MASTER_KEY;
    delete process.env.VOTE_SIGNING_MASTER_KEY;
    try {
      // serverEnv() caches its first read, so exercise the parser the freeze command uses.
      expect(() => parseMasterKey(process.env.VOTE_SIGNING_MASTER_KEY)).toThrow(/32 random bytes/);
      expect(() => parseMasterKey("c2hvcnQ=")).toThrow(/32 random bytes/);
    } finally {
      process.env.VOTE_SIGNING_MASTER_KEY = saved;
    }
  });
});

// --------------------------------------------------------------- mock rounds and counts (5.1, 5.2)

describe("mock ballots", () => {
  beforeEach(() => {
    clock = new Date();
  });

  const castOne = async (w: VotingWorld, pick = {}) => {
    const pending = await issued(w);
    return castBallot(castingDeps(), w.voting, {
      castToken: pending.castToken,
      idempotencyKey: idemKey(),
      answers: validAnswers(w, pick),
    });
  };

  it("mock first, then real: only the real ballots are counted", async () => {
    const w = await buildVotingWorld(admin, { booth: "setup", election: "frozen", now: clock });
    const as = (actor: Actor) => gw(actor);
    const run = (command: (typeof lifecycle)["startMockPoll"], actor: Actor = w.po) =>
      executeCommand(command, { electionId: w.electionId, boothId: w.boothId }, as(actor));

    await run(lifecycle.startMockPoll);
    expect(await counters(w.boothId)).toMatchObject({ mock_round: 1 });

    // Three mock ballots through the very same path.
    for (let i = 0; i < 3; i++)
      expect(await castOne(w, { president: i % 3 })).toEqual({ status: "cast" });
    expect(await rowCount(w.boothId, true)).toBe(9);
    expect(await counters(w.boothId)).toMatchObject({ cast: 0 });

    // Clearing records the mock counts in the audit log.
    await run(lifecycle.clearMockPoll);
    const [cleared] = await auditEvents(app, {
      electionId: w.electionId,
      eventType: "booth.mock_poll_cleared",
    });
    expect(cleared!.payload.detail).toMatchObject({
      guards: { mockBallotCast: { mock_round: 1, mock_ballots: 3 } },
    });

    // Open the poll (the Election must be Polling Open) and cast 10 real ballots.
    await executeCommand(lifecycle.startPolling, { electionId: w.electionId }, as(w.ro));
    await run(lifecycle.openPoll);
    for (let i = 0; i < 10; i++)
      expect(await castOne(w, { council: [i % 3, (i + 1) % 3] })).toEqual({ status: "cast" });

    expect(await counters(w.boothId)).toMatchObject({ cast: 10, cancelled: 0 });
    expect(await rowCount(w.boothId, false)).toBe(30);

    // Results include only the 10 real ballots: close, complete, then read the sealed tally.
    await run(lifecycle.closePoll);
    await executeCommand(lifecycle.completePolls, { electionId: w.electionId }, as(w.ro));
    const tally = await app.query<{ post_id: string; votes: string }>(
      "select post_id, votes from public.election_tally($1)",
      [w.electionId],
    );
    const perPost = (post: string) =>
      tally.rows.filter((r) => r.post_id === post).reduce((sum, r) => sum + Number(r.votes), 0);
    expect(perPost(w.presidentId)).toBe(10); // one President choice per real ballot
    expect(perPost(w.councilId)).toBe(20); // two Councillors per real ballot
  });

  it("shows the Presiding Officer the current round's mock counts only", async () => {
    const w = await buildVotingWorld(admin, { booth: "mock_poll", election: "frozen", now: clock });
    await castOne(w, { president: 0 });
    await castOne(w, { president: 0 });
    await castOne(w, { president: 2 });

    const counts = await getMockCounts(app, w.po, w.boothId);
    expect(counts).toMatchObject({ round: 1, mockBallots: 3 });
    const president = counts.options.filter((o) => o.postId === w.presidentId);
    expect(president.map((o) => [o.name, o.votes])).toEqual([
      ["President 0", 2],
      ["President 2", 1],
    ]);

    // Repeating the mock poll starts round 2; round 1 is no longer visible.
    await admin.query("update public.booth_counters set mock_round = 2 where booth_id = $1", [
      w.boothId,
    ]);
    expect(await getMockCounts(app, w.po, w.boothId)).toMatchObject({
      round: 2,
      mockBallots: 0,
      options: [],
    });
  });

  it("is refused to the Presiding Officer of another booth, and to others (negative tests)", async () => {
    const w = await buildVotingWorld(admin, { booth: "mock_poll", election: "frozen", now: clock });
    const other = await buildVotingWorld(admin, {
      booth: "mock_poll",
      election: "frozen",
      now: clock,
    });
    await expectError(getMockCounts(app, other.po, w.boothId), "forbidden");
    await expectError(getMockCounts(app, w.ro, w.boothId), "forbidden");
  });

  it("never exposes real votes through the mock reader", async () => {
    const w = await buildVotingWorld(admin, { now: clock }); // an Open booth: real ballots
    await castOne(w);
    await castOne(w);
    expect(await rowCount(w.boothId, false)).toBe(6);
    const { rows } = await app.query("select * from public.mock_counts($1, 0)", [w.boothId]);
    expect(rows).toEqual([]);
    expect(await getMockCounts(app, w.po, w.boothId)).toMatchObject({ options: [] });
  });
});

// ------------------------------------------------------------------------------ logging (5.3)

describe("logging", () => {
  const records: LogRecord[] = [];
  beforeEach(() => {
    clock = new Date();
    records.length = 0;
    setLogSink((record) => records.push(record));
  });
  afterEach(() => setLogSink(null));

  it("a rejected cast logs the error code and booth, but no choice ids", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    const result = await castBallot(castingDeps(), w.voting, {
      castToken: pending.castToken,
      idempotencyKey: idemKey(),
      answers: [
        { postId: w.presidentId, candidateIds: [w.presidents[0], w.presidents[1]] },
        { postId: w.councilId, nota: true, candidateIds: [w.councillors[0]] },
      ],
    });
    expect(result.status).toBe("invalid");

    expect(records.length).toBeGreaterThan(0);
    const logged = JSON.stringify(records);
    expect(logged).toContain("invalid_ballot");
    expect(logged).toContain(w.boothId);
    for (const id of [...w.presidents, ...w.councillors]) expect(logged).not.toContain(id);
    expect(logged).not.toContain("candidateIds");
    expect(logged).not.toContain(pending.castToken);
  });
});

// ----------------------------------------------------------------------- secrecy (5.4)

describe("secrecy", () => {
  beforeEach(() => {
    clock = new Date();
  });

  /** Spearman rank correlation of two equally long numeric arrays. */
  function spearman(a: number[], b: number[]): number {
    const rank = (values: number[]) => {
      const order = values.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
      const ranks = new Array<number>(values.length);
      order.forEach(([, i], r) => (ranks[i] = r));
      return ranks;
    };
    const ra = rank(a);
    const rb = rank(b);
    const n = a.length;
    const d2 = ra.reduce((sum, r, i) => sum + (r - rb[i]!) ** 2, 0);
    return 1 - (6 * d2) / (n * (n * n - 1));
  }

  it("after 50 random casts nothing links a vote to a session, and row order is unrelated to id order", async () => {
    const w = await buildVotingWorld(admin, { nota: true, now: clock });
    const pick = (n: number) => Math.floor(Math.random() * n);
    for (let i = 0; i < 50; i++) {
      const pending = await issued(w);
      const councillors: [number, number] = (() => {
        const a = pick(3);
        return [a, (a + 1 + pick(2)) % 3];
      })();
      const result = await castBallot(castingDeps(), w.voting, {
        castToken: pending.castToken,
        idempotencyKey: idemKey(),
        answers: validAnswers(w, {
          president: Math.random() < 0.15 ? "nota" : pick(3),
          council: Math.random() < 0.15 ? "nota" : councillors,
        }),
      });
      expect(result).toEqual({ status: "cast" });
    }
    expect(await counters(w.boothId)).toMatchObject({ cast: 50 });

    // 1. Structure: no column or constraint can tie votes to sessions, terminals or time.
    const links = await admin.query(
      `select 1 from pg_constraint c
        where c.contype = 'f'
          and ((c.conrelid = 'public.vote_selections'::regclass and c.confrelid = 'public.ballot_sessions'::regclass)
            or (c.conrelid = 'public.ballot_sessions'::regclass and c.confrelid = 'public.vote_selections'::regclass))`,
    );
    expect(links.rows).toEqual([]);

    // 2. Content: no stored vote row contains any session id, terminal id or timestamp.
    const sessionIds = (
      await admin.query<{ id: string }>(
        "select id from public.ballot_sessions where booth_id = $1",
        [w.boothId],
      )
    ).rows.map((r) => r.id);
    expect(sessionIds).toHaveLength(50);
    const votes = await admin.query<{ id: string; text: string; ctid: string }>(
      "select id, v::text as text, ctid::text as ctid from public.vote_selections v where booth_id = $1",
      [w.boothId],
    );
    for (const row of votes.rows) {
      for (const sessionId of sessionIds) expect(row.text).not.toContain(sessionId);
      expect(row.text).not.toContain(w.voting.id);
      expect(row.text).not.toContain(w.po.userId);
    }

    // 3. No identifier is shared between selections of one ballot (or any two selections).
    const distinct = await admin.query<{ ids: string; sigs: string }>(
      "select count(distinct id) ids, count(distinct signature) sigs from public.vote_selections where booth_id = $1",
      [w.boothId],
    );
    expect(Number(distinct.rows[0]!.ids)).toBe(votes.rows.length);
    expect(Number(distinct.rows[0]!.sigs)).toBe(votes.rows.length);

    // 4. Order: sorted by id, the rows are uncorrelated with the order they were written in.
    // (ctid is the heap position; the table is append-only, so it follows insertion order.)
    const byPosition = [...votes.rows].sort((x, y) => {
      const [bx, tx] = x.ctid.slice(1, -1).split(",").map(Number) as [number, number];
      const [by, ty] = y.ctid.slice(1, -1).split(",").map(Number) as [number, number];
      return bx - by || tx - ty;
    });
    const idsSorted = [...votes.rows].map((r) => r.id).sort();
    const idRank = new Map(idsSorted.map((id, i) => [id, i]));
    const rho = spearman(
      byPosition.map((_, position) => position),
      byPosition.map((row) => idRank.get(row.id)!),
    );
    expect(votes.rows.length).toBeGreaterThanOrEqual(100);
    expect(Math.abs(rho)).toBeLessThan(0.35);
  });

  it("the application role cannot read, change or remove stored votes", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    await castBallot(castingDeps(), w.voting, {
      castToken: pending.castToken,
      idempotencyKey: idemKey(),
      answers: validAnswers(w),
    });
    for (const sql of [
      "select * from public.vote_selections",
      "select count(*) from public.vote_selections",
      "update public.vote_selections set is_nota = false",
      "delete from public.vote_selections",
      "truncate public.vote_selections",
    ]) {
      await expect(app.query(sql)).rejects.toMatchObject({ code: "42501" });
    }
    // Per-candidate counts stay sealed while polling is open.
    await expect(
      app.query("select * from public.election_tally($1)", [w.electionId]),
    ).rejects.toMatchObject({ code: "42501" });
    // And no statistics about the votes leak through the catalogue.
    const stats = await app.query("select * from pg_stats where tablename = 'vote_selections'");
    expect(stats.rows).toEqual([]);
  });

  it("an issued ballot of another staff member's election cannot be cast through this booth", async () => {
    const w = await buildVotingWorld(admin, { now: clock });
    const other = await buildVotingWorld(admin, { now: clock });
    const pending = await issued(w);
    // The other booth's terminal presents this booth's cast token.
    expect(
      await castBallot(castingDeps(), other.voting, {
        castToken: pending.castToken,
        idempotencyKey: idemKey(),
        answers: validAnswers(other),
      }),
    ).toEqual({ status: "rejected", reason: "bad_token" });
    expect(await rowCount(w.boothId)).toBe(0);
    expect(await rowCount(other.boothId)).toBe(0);
  });
});
