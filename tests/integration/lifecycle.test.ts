import { ensureElectionSigningKey, parseMasterKey } from "@/lib/votes/keys";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import type { Actor } from "@/lib/auth/roles";
import { CommandError } from "@/lib/commands/errors";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { createLifecycleCommands } from "@/lib/lifecycle/engine";
import { createAppLifecycle } from "@/lib/lifecycle/app";
import { ballotGuards } from "@/lib/votes/guards";
import { defaultGuards, pass } from "@/lib/lifecycle/guards";
import { MemorySignalBus } from "@/lib/signals/memory";
import { OFFLINE_AFTER_MS } from "@/lib/terminals/state";
import {
  actorFor,
  adminPool,
  appPool,
  auditEvents,
  createStaffFixture,
  insertBallotSession,
  setBoothState,
  type BoothStateName,
} from "../support/fixtures";

const app = appPool();
const admin = adminPool();
const bus = new MemorySignalBus();

let clock = new Date();
const now = () => clock;

// The application's own guards and hooks, against the real tables (no fixture tables).
const commands = createAppLifecycle(bus);
const guards = { ...defaultGuards, ...ballotGuards };

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const gw = (actor: Actor): Partial<GatewayDeps> => ({
  db: app,
  now,
  authenticate: async () => actor,
  appendAudit: appendAuditEvent,
});

async function expectError(promise: Promise<unknown>, code: string, message?: RegExp) {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) =>
      e instanceof CommandError && e.code === code && (!message || message.test(e.message)),
  );
}

type ElectionStatus = "frozen" | "polling_open" | "polling_completed" | "results_declared";
const ELECTION_PATH: ElectionStatus[] = [
  "frozen",
  "polling_open",
  "polling_completed",
  "results_declared",
];

/** An Election at `status` with one booth at `booth`, its Presiding Officer and Returning Officer. */
async function world(
  options: {
    status?: ElectionStatus;
    booth?: BoothStateName;
    terminals?: "none" | "online" | "offline";
  } = {},
) {
  const { status = "polling_open", booth = "setup", terminals = "online" } = options;
  const electionId = randomUUID();
  const boothId = randomUUID();
  await admin.query(
    "insert into public.elections (id, name, polling_date) values ($1, $2, current_date)",
    [electionId, `Lifecycle ${electionId}`],
  );
  await admin.query(
    "insert into public.booths (id, election_id, name, location) values ($1, $2, 'Hall', 'A')",
    [boothId, electionId],
  );
  const postId = randomUUID();
  const candidateIds = [randomUUID(), randomUUID()];
  await admin.query(
    "insert into public.posts (id, election_id, name, display_order, seats) values ($1, $2, 'President', 0, 1)",
    [postId, electionId],
  );
  for (const [i, id] of candidateIds.entries()) {
    await admin.query(
      "insert into public.candidates (id, election_id, post_id, name, sort_order) values ($1, $2, $3, $4, $5)",
      [id, electionId, postId, `Candidate ${i}`, i],
    );
  }
  const po = actorFor(
    await createStaffFixture(admin, [{ role: "presiding_officer", electionId, boothId }]),
  );
  const ro = actorFor(await createStaffFixture(admin, [{ role: "returning_officer", electionId }]));
  await admin.query(
    "update public.elections set status = 'frozen', frozen_at = now(), freeze_count = 1 where id = $1",
    [electionId],
  );
  // Every frozen Election has a signing key; closing a booth signs its Booth Tally with it.
  await ensureElectionSigningKey(
    admin,
    electionId,
    parseMasterKey(process.env.VOTE_SIGNING_MASTER_KEY),
  );
  await advanceElection(electionId, status);
  if (terminals !== "none") {
    for (const type of ["master", "voting"] as const) {
      const { rows } = await admin.query<{ id: string }>(
        `insert into public.terminals (election_id, booth_id, type, credential_hash)
         values ($1, $2, $3, $4) returning id`,
        [electionId, boothId, type, randomBytes(32).toString("hex")],
      );
      if (type === "voting") {
        const seen =
          terminals === "online" ? clock : new Date(clock.getTime() - OFFLINE_AFTER_MS - 5000);
        await admin.query(
          "insert into public.terminal_heartbeats (terminal_id, last_seen_at) values ($1, $2)",
          [rows[0]!.id, seen],
        );
      }
    }
  }
  await setBoothState(admin, boothId, booth);
  return { electionId, boothId, po, ro, postId, candidateIds };
}

async function advanceElection(electionId: string, target: ElectionStatus) {
  for (const next of ELECTION_PATH.slice(1, ELECTION_PATH.indexOf(target) + 1)) {
    await admin.query("update public.elections set status = $2 where id = $1", [electionId, next]);
  }
}

const boothState = async (boothId: string) =>
  (
    await admin.query("select state::text s from public.booth_states where booth_id = $1", [
      boothId,
    ])
  ).rows[0].s;
const electionStatus = async (electionId: string) =>
  (await admin.query("select status::text s from public.elections where id = $1", [electionId]))
    .rows[0].s;
const addSession = (boothId: string, status: "pending" | "cast" | "cancelled", mock = false) =>
  insertBallotSession(admin, { boothId, status, isMock: mock });
const cancelSession = (id: string) =>
  admin.query(
    "update public.ballot_sessions set status = 'cancelled', finished_at = now(), cancel_reason = 'voter_left' where id = $1",
    [id],
  );

describe("transition engine", () => {
  it("two identical open-poll requests at once give exactly one success", async () => {
    clock = new Date();
    const w = await world({ booth: "mock_cleared" });
    const attempts = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        executeCommand(
          commands.openPoll,
          { electionId: w.electionId, boothId: w.boothId },
          gw(w.po),
        ),
      ),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((a) => a.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(CommandError);
    expect((rejected.reason as CommandError).code).toBe("invalid_transition");

    expect(await boothState(w.boothId)).toBe("open");
    const events = await auditEvents(app, {
      electionId: w.electionId,
      eventType: "booth.poll_opened",
    });
    expect(events).toHaveLength(1);
    const version = await app.query(
      "select version from public.booth_state_versions where booth_id = $1",
      [w.boothId],
    );
    expect(Number(version.rows[0].version)).toBe(1); // one increment for one transition
  });

  it("records the transition, the state version and a signal after commit", async () => {
    clock = new Date();
    const w = await world({ booth: "setup" });
    bus.published.length = 0;
    await executeCommand(
      commands.startMockPoll,
      { electionId: w.electionId, boothId: w.boothId },
      gw(w.po),
    );
    expect(bus.published).toEqual([
      { boothId: w.boothId, signal: { type: "booth-state-changed", version: 1 } },
    ]);
    const [event] = await auditEvents(app, {
      electionId: w.electionId,
      eventType: "booth.mock_poll_started",
    });
    expect(event!.payload).toMatchObject({
      actor: { user_id: w.po.userId, role: "presiding_officer" },
      target: { type: "booth", id: w.boothId },
      before: { state: "setup" },
      after: { state: "mock_poll", version: 1 },
    });
  });

  it("a transition blocked by a guard changes nothing and sends no signal", async () => {
    clock = new Date();
    const w = await world({ booth: "mock_cleared", terminals: "offline" });
    bus.published.length = 0;
    await expectError(
      executeCommand(commands.openPoll, { electionId: w.electionId, boothId: w.boothId }, gw(w.po)),
      "lifecycle",
      /offline/,
    );
    expect(await boothState(w.boothId)).toBe("mock_cleared");
    expect(bus.published).toEqual([]);
  });

  it("an unregistered guard blocks the transition (fails closed)", async () => {
    const w = await world({ booth: "mock_poll" });
    const bare = createLifecycleCommands({ publisher: bus }); // default registry: no ballot guards
    await expectError(
      executeCommand(
        bare.clearMockPoll,
        { electionId: w.electionId, boothId: w.boothId },
        gw(w.po),
      ),
      "lifecycle",
      /not available yet/,
    );
    expect(await boothState(w.boothId)).toBe("mock_poll");
  });

  it("rolls the whole transition back if the Audit Event cannot be written", async () => {
    const w = await world({ booth: "setup" });
    await expect(
      executeCommand(
        commands.startMockPoll,
        { electionId: w.electionId, boothId: w.boothId },
        {
          ...gw(w.po),
          appendAudit: async () => {
            throw new Error("injected audit failure");
          },
        },
      ),
    ).rejects.toThrow("injected audit failure");
    expect(await boothState(w.boothId)).toBe("setup");
  });
});

describe("Election transitions", () => {
  it("start polling: the Returning Officer moves Frozen to Polling Open and booths are signalled", async () => {
    const w = await world({ status: "frozen" });
    bus.published.length = 0;
    const result = await executeCommand(
      commands.startPolling,
      { electionId: w.electionId },
      gw(w.ro),
    );
    expect(result).toEqual({ from: "frozen", to: "polling_open" });
    expect(await electionStatus(w.electionId)).toBe("polling_open");
    expect(bus.published.map((p) => p.boothId)).toEqual([w.boothId]);
    expect(
      await auditEvents(app, { electionId: w.electionId, eventType: "election.polling_started" }),
    ).toHaveLength(1);
  });

  it("start polling is refused to anyone else (negative tests, audited)", async () => {
    const w = await world({ status: "frozen" });
    const other = await world({ status: "frozen" });
    const sa = actorFor(await createStaffFixture(admin, [{ role: "super_admin" }]));
    for (const actor of [other.ro, w.po, sa]) {
      await expectError(
        executeCommand(commands.startPolling, { electionId: w.electionId }, gw(actor)),
        "forbidden",
      );
    }
    expect(await electionStatus(w.electionId)).toBe("frozen");
    const denied = await auditEvents(app, {
      electionId: null,
      eventType: "authz.denied",
      actorId: other.ro.userId,
    });
    expect(denied.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects skipping a state and going backwards", async () => {
    const polling = await world({ status: "polling_open" });
    await expectError(
      executeCommand(commands.declareResults, { electionId: polling.electionId }, gw(polling.ro)),
      "invalid_transition",
    );
    const completed = await world({ status: "polling_completed" });
    await expectError(
      executeCommand(commands.startPolling, { electionId: completed.electionId }, gw(completed.ro)),
      "invalid_transition",
    );
    const draftId = randomUUID();
    await admin.query(
      "insert into public.elections (id, name, polling_date) values ($1, 'D', current_date)",
      [draftId],
    );
    const ro = actorFor(
      await createStaffFixture(admin, [{ role: "returning_officer", electionId: draftId }]),
    );
    await expectError(
      executeCommand(commands.startPolling, { electionId: draftId }, gw(ro)),
      "invalid_transition",
    );
  });

  it("complete all polls: rejected naming an open booth", async () => {
    clock = new Date();
    const w = await world({ booth: "open" });
    await expectError(
      executeCommand(commands.completePolls, { electionId: w.electionId }, gw(w.ro)),
      "lifecycle",
      /Booth "Hall" is open, not Closed/,
    );
    expect(await electionStatus(w.electionId)).toBe("polling_open");
    expect(await boothState(w.boothId)).toBe("open");
  });

  it("complete all polls needs recent re-authentication (negative test)", async () => {
    const w = await world({ booth: "closed" });
    const stale = Math.floor(Date.now() / 1000) - 3600;
    await expectError(
      executeCommand(
        commands.completePolls,
        { electionId: w.electionId },
        gw({ ...w.ro, authTimes: { password: stale, totp: stale } }),
      ),
      "reauth_required",
    );
    expect(await electionStatus(w.electionId)).toBe("polling_open");
  });

  it("complete all polls seals every booth and completes the Election in one step", async () => {
    clock = new Date();
    const w = await world({ booth: "closed" });
    const second = randomUUID();
    // A second booth, also Closed (created while the election is Draft is no longer possible,
    // so use the owner connection with the Draft-only trigger's own rule: add via a clone).
    await admin.query("alter table public.booths disable trigger booths_draft_only");
    try {
      await admin.query(
        "insert into public.booths (id, election_id, name, location) values ($1, $2, 'Annex', 'B')",
        [second, w.electionId],
      );
    } finally {
      await admin.query("alter table public.booths enable trigger booths_draft_only");
    }
    await setBoothState(admin, second, "closed");

    bus.published.length = 0;
    await executeCommand(commands.completePolls, { electionId: w.electionId }, gw(w.ro));
    expect(await electionStatus(w.electionId)).toBe("polling_completed");
    expect(await boothState(w.boothId)).toBe("sealed");
    expect(await boothState(second)).toBe("sealed");
    const [event] = await auditEvents(app, {
      electionId: w.electionId,
      eventType: "election.polls_completed",
    });
    expect((event!.payload.detail as { sealed_booths: string[] }).sealed_booths.sort()).toEqual(
      [w.boothId, second].sort(),
    );
    expect(new Set(bus.published.map((p) => p.boothId))).toEqual(new Set([w.boothId, second]));
  });

  it("declare results fails closed until the reconciliation and results guards are registered", async () => {
    const w = await world({ status: "polling_completed" });
    await expectError(
      executeCommand(commands.declareResults, { electionId: w.electionId }, gw(w.ro)),
      "lifecycle",
      /resultsReady/,
    );
    const ready = createLifecycleCommands({
      publisher: bus,
      guards: {
        ...guards,
        reconciliationPassed: async () => pass(),
        resultsReady: async () => pass(),
      },
    });
    await executeCommand(ready.declareResults, { electionId: w.electionId }, gw(w.ro));
    expect(await electionStatus(w.electionId)).toBe("results_declared");
  });

  it("archive: only a Super Admin (an RO is rejected)", async () => {
    const w = await world({ status: "results_declared" });
    await expectError(
      executeCommand(commands.archive, { electionId: w.electionId }, gw(w.ro)),
      "forbidden",
    );
    const sa = actorFor(await createStaffFixture(admin, [{ role: "super_admin" }]));
    await executeCommand(commands.archive, { electionId: w.electionId }, gw(sa));
    expect(await electionStatus(w.electionId)).toBe("archived");
    await expectError(
      executeCommand(commands.archive, { electionId: w.electionId }, gw(sa)),
      "invalid_transition",
    );
  });
});

describe("booth transitions", () => {
  it("start mock poll is rejected without a Voting Terminal (and without a Master Terminal)", async () => {
    const w = await world({ booth: "setup", terminals: "none" });
    await expectError(
      executeCommand(
        commands.startMockPoll,
        { electionId: w.electionId, boothId: w.boothId },
        gw(w.po),
      ),
      "lifecycle",
      /no paired Voting Terminal/,
    );
    await expectError(
      executeCommand(
        commands.startMockPoll,
        { electionId: w.electionId, boothId: w.boothId },
        gw(w.po),
      ),
      "lifecycle",
      /no active Master Terminal/,
    );
    expect(await boothState(w.boothId)).toBe("setup");
  });

  it("start mock poll needs a Frozen or Polling Open Election and the booth's own Presiding Officer", async () => {
    const done = await world({ status: "polling_completed", booth: "setup" });
    await expectError(
      executeCommand(
        commands.startMockPoll,
        { electionId: done.electionId, boothId: done.boothId },
        gw(done.po),
      ),
      "lifecycle",
      /Frozen or Polling Open/,
    );
    const w = await world({ booth: "setup" });
    const other = await world({ booth: "setup" });
    await expectError(
      executeCommand(
        commands.startMockPoll,
        { electionId: w.electionId, boothId: w.boothId },
        gw(other.po),
      ),
      "forbidden",
    );
    // A Presiding Officer cannot use their grant against a booth of another Election.
    await expectError(
      executeCommand(
        commands.startMockPoll,
        { electionId: other.electionId, boothId: w.boothId },
        gw(other.po),
      ),
      "forbidden",
    );
    await expectError(
      executeCommand(
        commands.startMockPoll,
        { electionId: w.electionId, boothId: w.boothId },
        gw(w.ro),
      ),
      "forbidden",
    );
  });

  it("clear mock poll: rejected with zero mock ballots; with some, their counts go to the audit log", async () => {
    const w = await world({ booth: "mock_poll" });
    const clear = () =>
      executeCommand(
        commands.clearMockPoll,
        { electionId: w.electionId, boothId: w.boothId },
        gw(w.po),
      );
    await expectError(clear(), "lifecycle", /no mock ballot has been cast/);

    await admin.query("update public.booth_counters set mock_round = 1 where booth_id = $1", [
      w.boothId,
    ]);
    for (let i = 0; i < 3; i++) await addSession(w.boothId, "cast", true);
    // Three mock ballots: two for candidate 0, one for candidate 1 (rows the owner inserts,
    // standing in for what the cast path stores).
    for (const candidate of [0, 0, 1]) {
      await admin.query(
        `insert into public.vote_selections
           (election_id, booth_id, post_id, candidate_id, is_mock, mock_round, signature)
         values ($1, $2, $3, $4, true, 1, repeat('A', 86))`,
        [w.electionId, w.boothId, w.postId, w.candidateIds[candidate]],
      );
    }

    const pending = await addSession(w.boothId, "pending", true);
    await expectError(clear(), "lifecycle", /Ballot Session is pending/);
    await cancelSession(pending);

    await clear();
    expect(await boothState(w.boothId)).toBe("mock_cleared");
    const [event] = await auditEvents(app, {
      electionId: w.electionId,
      eventType: "booth.mock_poll_cleared",
    });
    const expected = [
      { post_id: w.postId, option: w.candidateIds[0], count: 2 },
      { post_id: w.postId, option: w.candidateIds[1], count: 1 },
    ].sort((x, y) => `${x.option}`.localeCompare(`${y.option}`));
    expect(event!.payload.detail).toMatchObject({
      guards: { mockBallotCast: { mock_round: 1, mock_ballots: 3, mock_tally: expected } },
    });
    // Clearing counted nothing as a real ballot.
    const counters = await admin.query(
      "select ballots_cast from public.booth_counters where booth_id = $1",
      [w.boothId],
    );
    expect(Number(counters.rows[0].ballots_cast)).toBe(0);
  });

  it("repeat mock poll: Mock Cleared goes back to Mock Poll", async () => {
    const w = await world({ booth: "mock_cleared" });
    await executeCommand(
      commands.repeatMockPoll,
      { electionId: w.electionId, boothId: w.boothId },
      gw(w.po),
    );
    expect(await boothState(w.boothId)).toBe("mock_poll");
    await expectError(
      executeCommand(
        commands.repeatMockPoll,
        { electionId: w.electionId, boothId: w.boothId },
        gw(w.po),
      ),
      "invalid_transition",
    );
  });

  describe("open poll", () => {
    const open = (w: Awaited<ReturnType<typeof world>>, actor: Actor = w.po) =>
      executeCommand(
        commands.openPoll,
        { electionId: w.electionId, boothId: w.boothId },
        gw(actor),
      );

    it("opens when every guard passes", async () => {
      clock = new Date();
      const w = await world({ booth: "mock_cleared" });
      expect(await open(w)).toMatchObject({ from: "mock_cleared", to: "open" });
      expect(await boothState(w.boothId)).toBe("open");
    });

    it("is rejected while the Election is only Frozen (negative test)", async () => {
      clock = new Date();
      const w = await world({ status: "frozen", booth: "mock_cleared" });
      await expectError(open(w), "lifecycle", /not Polling Open yet/);
    });

    it("is rejected while a Ballot Session is pending (negative test)", async () => {
      clock = new Date();
      const w = await world({ booth: "mock_cleared" });
      await addSession(w.boothId, "pending");
      await expectError(open(w), "lifecycle", /Ballot Session is pending/);
    });

    it("is rejected once a real ballot has been cast (negative test)", async () => {
      clock = new Date();
      const w = await world({ booth: "mock_cleared" });
      await addSession(w.boothId, "cast", false);
      await expectError(open(w), "lifecycle", /real ballots have already been cast/);
    });

    it("is rejected while the Voting Terminal is offline (negative test)", async () => {
      clock = new Date();
      const w = await world({ booth: "mock_cleared", terminals: "offline" });
      await expectError(open(w), "lifecycle", /Voting Terminal is offline/);
      const none = await world({ booth: "mock_cleared", terminals: "none" });
      await expectError(open(none), "lifecycle", /Voting Terminal is offline/);
    });

    it("needs recent re-authentication (negative test)", async () => {
      clock = new Date();
      const w = await world({ booth: "mock_cleared" });
      const stale = Math.floor(Date.now() / 1000) - 3600;
      await expectError(
        open(w, { ...w.po, authTimes: { password: stale, totp: null } }),
        "reauth_required",
      );
      expect(await boothState(w.boothId)).toBe("mock_cleared");
    });

    it("is rejected unless the booth is Mock Cleared (negative test)", async () => {
      clock = new Date();
      for (const state of ["setup", "mock_poll", "closed"] as const) {
        const w = await world({ booth: state });
        await expectError(open(w), "invalid_transition");
      }
    });

    it("reports every failing guard at once", async () => {
      clock = new Date();
      const w = await world({ status: "frozen", booth: "mock_cleared", terminals: "offline" });
      await addSession(w.boothId, "pending");
      await expect(open(w)).rejects.toSatisfy(
        (e: unknown) =>
          e instanceof CommandError &&
          /Polling Open/.test(e.message) &&
          /pending/.test(e.message) &&
          /offline/.test(e.message),
      );
    });
  });

  describe("close poll", () => {
    const close = (w: Awaited<ReturnType<typeof world>>, actor: Actor = w.po) =>
      executeCommand(
        commands.closePoll,
        { electionId: w.electionId, boothId: w.boothId },
        gw(actor),
      );

    it("is rejected with a pending Ballot Session, then closes, and can never reopen", async () => {
      clock = new Date();
      const w = await world({ booth: "open" });
      const pending = await addSession(w.boothId, "pending");
      await expectError(close(w), "lifecycle", /wait for the vote or cancel the ballot/);
      await cancelSession(pending);

      await close(w);
      expect(await boothState(w.boothId)).toBe("closed");
      // Irreversible: opening, closing again or going back are all invalid transitions.
      await expectError(
        executeCommand(
          commands.openPoll,
          { electionId: w.electionId, boothId: w.boothId },
          gw(w.po),
        ),
        "invalid_transition",
      );
      await expectError(close(w), "invalid_transition");
      await expectError(
        executeCommand(
          commands.repeatMockPoll,
          { electionId: w.electionId, boothId: w.boothId },
          gw(w.po),
        ),
        "invalid_transition",
      );
      // And the database refuses a direct update too.
      await expect(
        app.query("update public.booth_states set state = 'open' where booth_id = $1", [w.boothId]),
      ).rejects.toMatchObject({ code: "P0001" });
    });

    it("needs recent re-authentication (negative test)", async () => {
      const w = await world({ booth: "open" });
      const stale = Math.floor(Date.now() / 1000) - 3600;
      await expectError(
        close(w, { ...w.po, authTimes: { password: stale, totp: null } }),
        "reauth_required",
      );
      expect(await boothState(w.boothId)).toBe("open");
    });
  });

  describe("force close by the Returning Officer", () => {
    const force = (
      w: Awaited<ReturnType<typeof world>>,
      reason: string | undefined,
      actor: Actor = w.ro,
    ) =>
      executeCommand(
        commands.forceClosePoll,
        { electionId: w.electionId, boothId: w.boothId, reason },
        gw(actor),
      );

    it("closes the booth, cancels a pending Ballot Session and records the reason", async () => {
      clock = new Date();
      const w = await world({ booth: "open" });
      await addSession(w.boothId, "pending");
      await force(w, "PO unwell");

      expect(await boothState(w.boothId)).toBe("closed");
      const sessions = await admin.query(
        "select status from public.ballot_sessions where booth_id = $1",
        [w.boothId],
      );
      expect(sessions.rows).toEqual([{ status: "cancelled" }]);
      const [event] = await auditEvents(app, {
        electionId: w.electionId,
        eventType: "booth.poll_force_closed",
      });
      expect(event!.payload).toMatchObject({
        actor: { user_id: w.ro.userId, role: "returning_officer" },
        before: { state: "open" },
        after: { state: "closed" },
        detail: {
          action: "force_close_poll",
          reason: "PO unwell",
          hooks: [
            { cancelled_ballot_sessions: 1 },
            { booth_tally: { tally_status: "pass", failed_checks: [] } },
          ],
        },
      });
    });

    it("needs a written reason (negative test)", async () => {
      const w = await world({ booth: "open" });
      for (const reason of [undefined, "", "  ", "x"]) {
        await expectError(force(w, reason), "invalid_input");
      }
      expect(await boothState(w.boothId)).toBe("open");
    });

    it("is for the Election's Returning Officer only (negative tests)", async () => {
      const w = await world({ booth: "open" });
      const other = await world({ booth: "open" });
      await expectError(force(w, "reason here", w.po), "forbidden");
      await expectError(force(w, "reason here", other.ro), "forbidden");
      // The right Returning Officer cannot reach a booth of another Election.
      await expectError(
        executeCommand(
          commands.forceClosePoll,
          { electionId: w.electionId, boothId: other.boothId, reason: "nope nope" },
          gw(w.ro),
        ),
        "not_found",
      );
      expect(await boothState(w.boothId)).toBe("open");
      expect(await boothState(other.boothId)).toBe("open");
    });

    it("needs recent re-authentication (negative test)", async () => {
      const w = await world({ booth: "open" });
      const stale = Math.floor(Date.now() / 1000) - 3600;
      await expectError(
        force(w, "reason here", { ...w.ro, authTimes: { password: stale, totp: stale } }),
        "reauth_required",
      );
    });
  });
});
