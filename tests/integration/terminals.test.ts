import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import type { Actor } from "@/lib/auth/roles";
import { CommandError } from "@/lib/commands/errors";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { createTerminalCommands } from "@/lib/commands/terminals";
import { MemorySignalBus } from "@/lib/signals/memory";
import {
  hashCredential,
  newCredentialToken,
  verifyTerminalCredential,
} from "@/lib/terminals/credentials";
import { guardTerminal } from "@/lib/terminals/guard";
import {
  collectPairing,
  submitPairingCode,
  deviceIdFor,
  type PairingDeps,
} from "@/lib/terminals/pairing";
import { actorFor, adminPool, appPool, auditEvents, createStaffFixture } from "../support/fixtures";

const app = appPool();
const admin = adminPool();
const bus = new MemorySignalBus();
const commands = createTerminalCommands(bus);

afterAll(async () => {
  await admin.query("drop table if exists public.ballot_sessions");
  await admin.query("drop table if exists public.booth_states");
  await Promise.all([app.end(), admin.end()]);
});

let clock = new Date();
const now = () => clock;

function gatewayDeps(actor: Actor): Partial<GatewayDeps> {
  return { db: app, now, authenticate: async () => actor, appendAudit: appendAuditEvent };
}
const pairingDeps: PairingDeps = { db: app, now, appendAudit: appendAuditEvent, publisher: bus };

async function expectCommandError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy(
    (e: unknown) => e instanceof CommandError && e.code === code,
  );
}

/** A Frozen Election with one booth and its Presiding Officer. */
async function frozenBooth(freeze = true) {
  const electionId = randomUUID();
  const boothId = randomUUID();
  await admin.query(
    "insert into public.elections (id, name, polling_date) values ($1, $2, current_date)",
    [electionId, `Terminals ${electionId}`],
  );
  await admin.query(
    "insert into public.booths (id, election_id, name, location) values ($1, $2, 'Hall', 'A')",
    [boothId, electionId],
  );
  const po = actorFor(
    await createStaffFixture(admin, [{ role: "presiding_officer", electionId, boothId }]),
  );
  if (freeze) {
    await admin.query(
      "update public.elections set status = 'frozen', frozen_at = now(), freeze_count = 1 where id = $1",
      [electionId],
    );
  }
  return { electionId, boothId, po };
}

async function registerMaster(f: Awaited<ReturnType<typeof frozenBooth>>) {
  return executeCommand(commands.registerMaster, { boothId: f.boothId }, gatewayDeps(f.po));
}

let ipCounter = 0;
const freshIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

/** Master generates a code; a kiosk submits it. Returns everything a test needs next. */
async function startPairing(f: Awaited<ReturnType<typeof frozenBooth>>, masterToken: string) {
  const generated = await executeCommand(
    commands.generatePairingCode,
    { boothId: f.boothId, masterToken },
    gatewayDeps(f.po),
  );
  const nonce = newCredentialToken();
  const submitted = await submitPairingCode(pairingDeps, {
    code: generated.code,
    ip: freshIp(),
    nonce,
  });
  return { generated, nonce, submitted };
}

async function pairVotingTerminal(f: Awaited<ReturnType<typeof frozenBooth>>, masterToken: string) {
  const { generated, nonce, submitted } = await startPairing(f, masterToken);
  if (submitted.status !== "pending") throw new Error(`submit failed: ${submitted.status}`);
  await executeCommand(
    commands.confirmPairing,
    { boothId: f.boothId, masterToken, codeId: generated.codeId, deviceId: submitted.deviceId },
    gatewayDeps(f.po),
  );
  const collected = await collectPairing(pairingDeps, { nonce });
  if (collected.status !== "paired") throw new Error(`collect failed: ${collected.status}`);
  return collected;
}

describe("terminal credentials", () => {
  it("accepts a valid credential and stores only its hash", async () => {
    clock = new Date();
    const f = await frozenBooth();
    const { token, terminalId } = await registerMaster(f);
    const check = await verifyTerminalCredential(app, token, {
      type: "master",
      boothId: f.boothId,
    });
    expect(check).toMatchObject({ ok: true, terminal: { id: terminalId, boothId: f.boothId } });

    const { rows } = await admin.query(
      "select credential_hash from public.terminals where id = $1",
      [terminalId],
    );
    expect(rows[0].credential_hash).toBe(hashCredential(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("rejects tampered, malformed, missing and unknown credentials (negative tests)", async () => {
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    for (const [presented, reason] of [
      [tampered, "unknown"],
      [newCredentialToken(), "unknown"],
      ["short", "malformed"],
      [undefined, "missing"],
    ] as const) {
      expect(await verifyTerminalCredential(app, presented, { type: "master" })).toMatchObject({
        ok: false,
        reason,
      });
    }
  });

  it("rejects a revoked credential (negative test)", async () => {
    const f = await frozenBooth();
    const { token, terminalId } = await registerMaster(f);
    await admin.query(
      "update public.terminals set status = 'revoked', revoked_at = now(), revoked_reason = 'test' where id = $1",
      [terminalId],
    );
    expect(await verifyTerminalCredential(app, token, { type: "master" })).toMatchObject({
      ok: false,
      reason: "revoked",
    });
  });

  it("rejects a credential used for another booth or another terminal type (negative tests)", async () => {
    const a = await frozenBooth();
    const b = await frozenBooth();
    const { token } = await registerMaster(a);
    expect(
      await verifyTerminalCredential(app, token, { type: "master", boothId: b.boothId }),
    ).toMatchObject({ ok: false, reason: "wrong_booth" });
    expect(await verifyTerminalCredential(app, token, { type: "voting" })).toMatchObject({
      ok: false,
      reason: "wrong_type",
    });
  });

  it("rejects every credential of a Closed or Sealed booth (fixture)", async () => {
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    await admin.query(
      "create table if not exists public.booth_states (booth_id uuid primary key, state text not null)",
    );
    await admin.query("grant select on public.booth_states to app_server");
    try {
      for (const state of ["closed", "sealed"]) {
        await admin.query(
          "insert into public.booth_states values ($1, $2) on conflict (booth_id) do update set state = $2",
          [f.boothId, state],
        );
        expect(await verifyTerminalCredential(app, token, { type: "master" })).toMatchObject({
          ok: false,
          reason: "booth_closed",
        });
      }
    } finally {
      await admin.query("drop table public.booth_states");
    }
  });
});

describe("Master Terminal registration", () => {
  it("registers the device, audits it, and bumps the booth state", async () => {
    const f = await frozenBooth();
    const { terminalId } = await registerMaster(f);
    const events = await auditEvents(app, {
      electionId: f.electionId,
      eventType: "terminal.master_registered",
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      actor: { user_id: f.po.userId, role: "presiding_officer" },
      target: { type: "terminal", id: terminalId },
      after: { booth_id: f.boothId, type: "master" },
    });
    expect(JSON.stringify(events)).not.toMatch(/token/i);
  });

  it("revokes the previous Master Terminal when a new one is registered", async () => {
    const f = await frozenBooth();
    const first = await registerMaster(f);
    const second = await registerMaster(f);
    expect(await verifyTerminalCredential(app, first.token, { type: "master" })).toMatchObject({
      ok: false,
      reason: "revoked",
    });
    expect(await verifyTerminalCredential(app, second.token, { type: "master" })).toMatchObject({
      ok: true,
    });
    bus.published.length = 0;
    await registerMaster(f);
    expect(bus.published.map((p) => p.signal.type)).toEqual(["terminal-revoked"]);
  });

  it("only the booth's own Presiding Officer can register (negative tests)", async () => {
    const a = await frozenBooth();
    const b = await frozenBooth();
    await expectCommandError(
      executeCommand(commands.registerMaster, { boothId: a.boothId }, gatewayDeps(b.po)),
      "forbidden",
    );
    const ro = actorFor(
      await createStaffFixture(admin, [{ role: "returning_officer", electionId: a.electionId }]),
    );
    await expectCommandError(
      executeCommand(commands.registerMaster, { boothId: a.boothId }, gatewayDeps(ro)),
      "forbidden",
    );
  });
});

describe("pairing code", () => {
  it("is 6 digits, valid for 2 minutes, and single use", async () => {
    clock = new Date();
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const generated = await executeCommand(
      commands.generatePairingCode,
      { boothId: f.boothId, masterToken: token },
      gatewayDeps(f.po),
    );
    expect(generated.code).toMatch(/^\d{6}$/);
    expect(generated.expiresAt.getTime() - clock.getTime()).toBe(2 * 60 * 1000);

    const stored = await admin.query("select code_hash from public.pairing_codes where id = $1", [
      generated.codeId,
    ]);
    expect(JSON.stringify(stored.rows)).not.toContain(generated.code);

    const first = await submitPairingCode(pairingDeps, {
      code: generated.code,
      ip: freshIp(),
      nonce: newCredentialToken(),
    });
    expect(first.status).toBe("pending");
    // Single use: the same code cannot be submitted again.
    const second = await submitPairingCode(pairingDeps, {
      code: generated.code,
      ip: freshIp(),
      nonce: newCredentialToken(),
    });
    expect(second.status).toBe("invalid");
  });

  it("expires after 2 minutes (clock-mocked)", async () => {
    clock = new Date();
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const gen = (async () =>
      executeCommand(
        commands.generatePairingCode,
        { boothId: f.boothId, masterToken: token },
        gatewayDeps(f.po),
      ))();
    const { code } = await gen;

    clock = new Date(clock.getTime() + 2 * 60 * 1000 + 1000);
    expect(
      await submitPairingCode(pairingDeps, { code, ip: freshIp(), nonce: newCredentialToken() }),
    ).toEqual({ status: "invalid" });
    clock = new Date();
  });

  it("is accepted just before expiry (clock-mocked)", async () => {
    clock = new Date();
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const { code } = await executeCommand(
      commands.generatePairingCode,
      { boothId: f.boothId, masterToken: token },
      gatewayDeps(f.po),
    );
    clock = new Date(clock.getTime() + 2 * 60 * 1000 - 1000);
    expect(
      (await submitPairingCode(pairingDeps, { code, ip: freshIp(), nonce: newCredentialToken() }))
        .status,
    ).toBe("pending");
    clock = new Date();
  });

  it("needs the booth's Master Terminal credential as well as the Presiding Officer login", async () => {
    const f = await frozenBooth();
    const other = await frozenBooth();
    const { token: mine } = await registerMaster(f);
    const { token: theirs } = await registerMaster(other);
    for (const masterToken of [theirs, newCredentialToken()]) {
      await expectCommandError(
        executeCommand(
          commands.generatePairingCode,
          { boothId: f.boothId, masterToken },
          gatewayDeps(f.po),
        ),
        "forbidden",
      );
    }
    await expect(
      executeCommand(
        commands.generatePairingCode,
        { boothId: f.boothId, masterToken: mine },
        gatewayDeps(f.po),
      ),
    ).resolves.toBeDefined();
  });

  it("a newer code invalidates the previous one", async () => {
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const gen = () =>
      executeCommand(
        commands.generatePairingCode,
        { boothId: f.boothId, masterToken: token },
        gatewayDeps(f.po),
      );
    const old = await gen();
    await gen();
    expect(
      await submitPairingCode(pairingDeps, {
        code: old.code,
        ip: freshIp(),
        nonce: newCredentialToken(),
      }),
    ).toEqual({ status: "invalid" });
  });
});

describe("kiosk pairing flow", () => {
  it("pending → confirmed → the kiosk receives a Voting Terminal credential once", async () => {
    clock = new Date();
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const { generated, nonce, submitted } = await startPairing(f, token);
    expect(submitted).toEqual({ status: "pending", deviceId: deviceIdFor(nonce) });

    expect(await collectPairing(pairingDeps, { nonce })).toEqual({
      status: "waiting",
      deviceId: deviceIdFor(nonce),
    });
    // No credential before the Presiding Officer confirms.
    expect(
      await admin.query("select 1 from public.terminals where booth_id = $1 and type = 'voting'", [
        f.boothId,
      ]),
    ).toHaveProperty("rowCount", 0);

    await executeCommand(
      commands.confirmPairing,
      {
        boothId: f.boothId,
        masterToken: token,
        codeId: generated.codeId,
        deviceId: deviceIdFor(nonce),
      },
      gatewayDeps(f.po),
    );
    const paired = await collectPairing(pairingDeps, { nonce });
    expect(paired).toMatchObject({ status: "paired", boothId: f.boothId });
    if (paired.status !== "paired") throw new Error("unreachable");
    expect(
      await verifyTerminalCredential(app, paired.token, { type: "voting", boothId: f.boothId }),
    ).toMatchObject({ ok: true });
    // The credential is handed out exactly once.
    expect(await collectPairing(pairingDeps, { nonce })).toEqual({ status: "completed" });

    const events = await auditEvents(app, { electionId: f.electionId });
    const types = events.map((e) => e.payload.event_type);
    expect(types).toEqual(
      expect.arrayContaining(["pairing.requested", "pairing.confirmed", "terminal.paired"]),
    );
    expect(JSON.stringify(events)).not.toContain(paired.token);
  });

  it("rejects when the Presiding Officer rejects, or confirms a different device id", async () => {
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const { generated, nonce } = await startPairing(f, token);
    await expectCommandError(
      executeCommand(
        commands.confirmPairing,
        { boothId: f.boothId, masterToken: token, codeId: generated.codeId, deviceId: "ZZZZ" },
        gatewayDeps(f.po),
      ),
      "conflict",
    );
    await executeCommand(
      commands.rejectPairing,
      {
        boothId: f.boothId,
        masterToken: token,
        codeId: generated.codeId,
        deviceId: deviceIdFor(nonce),
      },
      gatewayDeps(f.po),
    );
    expect(await collectPairing(pairingDeps, { nonce })).toEqual({ status: "rejected" });
    expect(
      await admin.query("select 1 from public.terminals where booth_id = $1 and type = 'voting'", [
        f.boothId,
      ]),
    ).toHaveProperty("rowCount", 0);
  });

  it("issues no credential if the Presiding Officer does not confirm in time (clock-mocked)", async () => {
    clock = new Date();
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const { generated, nonce } = await startPairing(f, token);
    clock = new Date(clock.getTime() + 2 * 60 * 1000 + 1000);
    expect(await collectPairing(pairingDeps, { nonce })).toEqual({ status: "expired" });
    await expectCommandError(
      executeCommand(
        commands.confirmPairing,
        {
          boothId: f.boothId,
          masterToken: token,
          codeId: generated.codeId,
          deviceId: deviceIdFor(nonce),
        },
        gatewayDeps(f.po),
      ),
      "lifecycle",
    );
    clock = new Date();
  });

  it("a stranger cannot collect someone else's pairing", async () => {
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    await startPairing(f, token);
    expect(await collectPairing(pairingDeps, { nonce: newCredentialToken() })).toEqual({
      status: "unknown",
    });
  });
});

describe("attempt limits", () => {
  it("rejects and audits the 6th attempt from one client, even with the right code", async () => {
    clock = new Date();
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const { code } = await executeCommand(
      commands.generatePairingCode,
      { boothId: f.boothId, masterToken: token },
      gatewayDeps(f.po),
    );
    const ip = freshIp();
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) {
      expect(
        await submitPairingCode(pairingDeps, { code: wrong, ip, nonce: newCredentialToken() }),
      ).toEqual({ status: "invalid" });
    }
    expect(await submitPairingCode(pairingDeps, { code, ip, nonce: newCredentialToken() })).toEqual(
      { status: "rate_limited" },
    );
    const blocked = await auditEvents(app, { electionId: null, eventType: "pairing.rate_limited" });
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    // Another client is unaffected.
    expect(
      (await submitPairingCode(pairingDeps, { code, ip: freshIp(), nonce: newCredentialToken() }))
        .status,
    ).toBe("pending");
  });

  it("invalidates a booth's code after 5 wrong codes aimed at it", async () => {
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const { code } = await executeCommand(
      commands.generatePairingCode,
      { boothId: f.boothId, masterToken: token },
      gatewayDeps(f.po),
    );
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) {
      await submitPairingCode(pairingDeps, {
        code: wrong,
        ip: freshIp(),
        nonce: newCredentialToken(),
        boothHint: f.boothId,
      });
    }
    expect(
      await submitPairingCode(pairingDeps, { code, ip: freshIp(), nonce: newCredentialToken() }),
    ).toEqual({ status: "invalid" });
    const events = await auditEvents(app, {
      electionId: f.electionId,
      eventType: "pairing.code_invalidated",
    });
    expect(events).toHaveLength(1);
  });
});

describe("replacement and availability rules", () => {
  it("pairing a replacement revokes the previous Voting Terminal", async () => {
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const first = await pairVotingTerminal(f, token);
    const second = await pairVotingTerminal(f, token);
    expect(await verifyTerminalCredential(app, first.token, { type: "voting" })).toMatchObject({
      ok: false,
      reason: "revoked",
    });
    expect(await verifyTerminalCredential(app, second.token, { type: "voting" })).toMatchObject({
      ok: true,
    });
    const revoked = await auditEvents(app, {
      electionId: f.electionId,
      eventType: "terminal.revoked",
    });
    expect(revoked).toHaveLength(1);
  });

  it("is blocked while a Ballot Session is pending (fixture, negative test)", async () => {
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    await pairVotingTerminal(f, token);
    await admin.query(
      "create table if not exists public.ballot_sessions (booth_id uuid not null, status text not null)",
    );
    await admin.query("grant select on public.ballot_sessions to app_server");
    await admin.query("insert into public.ballot_sessions values ($1, 'pending')", [f.boothId]);
    try {
      await expectCommandError(
        executeCommand(
          commands.generatePairingCode,
          { boothId: f.boothId, masterToken: token },
          gatewayDeps(f.po),
        ),
        "lifecycle",
      );
      await expectCommandError(
        executeCommand(commands.registerMaster, { boothId: f.boothId }, gatewayDeps(f.po)),
        "lifecycle",
      );
    } finally {
      await admin.query("drop table public.ballot_sessions");
    }
    // Nothing was replaced.
    const active = await admin.query(
      "select count(*) n from public.terminals where booth_id = $1 and status = 'active'",
      [f.boothId],
    );
    expect(Number(active.rows[0].n)).toBe(2);
  });

  it("a pending Ballot Session also blocks a confirmed pairing from completing", async () => {
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const { generated, nonce, submitted } = await startPairing(f, token);
    if (submitted.status !== "pending") throw new Error("unexpected");
    await executeCommand(
      commands.confirmPairing,
      {
        boothId: f.boothId,
        masterToken: token,
        codeId: generated.codeId,
        deviceId: submitted.deviceId,
      },
      gatewayDeps(f.po),
    );
    await admin.query(
      "create table if not exists public.ballot_sessions (booth_id uuid not null, status text not null)",
    );
    await admin.query("grant select on public.ballot_sessions to app_server");
    await admin.query("insert into public.ballot_sessions values ($1, 'pending')", [f.boothId]);
    try {
      expect(await collectPairing(pairingDeps, { nonce })).toEqual({ status: "unavailable" });
    } finally {
      await admin.query("drop table public.ballot_sessions");
    }
  });

  it("terminals cannot be registered in a Draft election (negative test)", async () => {
    const f = await frozenBooth(false);
    await expectCommandError(
      executeCommand(commands.registerMaster, { boothId: f.boothId }, gatewayDeps(f.po)),
      "lifecycle",
    );
  });

  it("pairing is refused at a Closed booth (fixture, negative test)", async () => {
    const f = await frozenBooth();
    const { token } = await registerMaster(f);
    const { code } = await executeCommand(
      commands.generatePairingCode,
      { boothId: f.boothId, masterToken: token },
      gatewayDeps(f.po),
    );
    await admin.query(
      "create table if not exists public.booth_states (booth_id uuid primary key, state text not null)",
    );
    await admin.query("grant select on public.booth_states to app_server");
    await admin.query("insert into public.booth_states values ($1, 'closed')", [f.boothId]);
    try {
      expect(
        await submitPairingCode(pairingDeps, { code, ip: freshIp(), nonce: newCredentialToken() }),
      ).toEqual({ status: "unavailable" });
      await expectCommandError(
        executeCommand(commands.registerMaster, { boothId: f.boothId }, gatewayDeps(f.po)),
        "lifecycle",
      );
    } finally {
      await admin.query("drop table public.booth_states");
    }
  });
});

describe("terminal-type authorization", () => {
  it("a Voting Terminal credential cannot use master routes, and the attempt is audited", async () => {
    const f = await frozenBooth();
    const { token: masterToken } = await registerMaster(f);
    const voting = await pairVotingTerminal(f, masterToken);
    const deps = { db: app, appendAudit: appendAuditEvent };

    const denied = await guardTerminal(deps, voting.token, { type: "master" }, "/master/api/state");
    expect(denied).toEqual({ ok: false, status: 403, error: "forbidden" });
    const events = await auditEvents(app, {
      electionId: f.electionId,
      eventType: "terminal.rejected",
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      detail: { reason: "wrong_type", credential_type: "voting", required_type: "master" },
    });

    expect(
      await guardTerminal(
        deps,
        voting.token,
        { type: "voting", boothId: f.boothId },
        "/terminal/api/state",
      ),
    ).toMatchObject({ ok: true });
    // And a master credential cannot use terminal routes.
    expect(
      await guardTerminal(deps, masterToken, { type: "voting" }, "/terminal/api/state"),
    ).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("an unknown or revoked credential is simply unauthenticated", async () => {
    const deps = { db: app, appendAudit: appendAuditEvent };
    expect(
      await guardTerminal(deps, newCredentialToken(), { type: "master" }, "/master/api/state"),
    ).toEqual({
      ok: false,
      status: 401,
      error: "unauthenticated",
    });
  });
});
