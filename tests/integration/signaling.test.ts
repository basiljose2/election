import { createHmac, randomUUID } from "node:crypto";
import { RealtimeClient } from "@supabase/realtime-js";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { appendAuditEvent } from "@/lib/audit/append";
import { boothGrant, type Actor } from "@/lib/auth/roles";
import { CommandError } from "@/lib/commands/errors";
import { defineCommand, executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { createTerminalCommands } from "@/lib/commands/terminals";
import { MemorySignalBus } from "@/lib/signals/memory";
import { signalAfterCommit } from "@/lib/signals/publish";
import { supabasePublisher } from "@/lib/signals/supabase";
import { supabaseSubscriber } from "@/lib/signals/supabase-client";
import {
  CHANNEL_TOKEN_TTL_SECONDS,
  mintChannelToken,
  verifyChannelToken,
} from "@/lib/signals/token";
import { newCredentialToken } from "@/lib/terminals/credentials";
import {
  collectPairing,
  deviceIdFor,
  submitPairingCode,
  type PairingDeps,
} from "@/lib/terminals/pairing";
import { OFFLINE_AFTER_MS, getTerminalState, recordHeartbeat } from "@/lib/terminals/state";
import { actorFor, adminPool, appPool, auditEvents, createStaffFixture } from "../support/fixtures";
import { assertLocal } from "../support/local-only";
import { describeSignalBusContract } from "../support/signal-contract";

const app = appPool();
const admin = adminPool();
const supabaseUrl = assertLocal("SUPABASE_URL", process.env.SUPABASE_URL);
const jwtSecret = process.env.SUPABASE_JWT_SECRET!;
const apiKey = process.env.SUPABASE_PUBLISHABLE_KEY!;
const secretKey = process.env.SUPABASE_SECRET_KEY!;

afterAll(async () => {
  await admin.query("drop table if exists public.ballot_sessions");
  await Promise.all([app.end(), admin.end()]);
});

let clock = new Date();
const now = () => clock;

async function booth() {
  const electionId = randomUUID();
  const boothId = randomUUID();
  await admin.query(
    "insert into public.elections (id, name, polling_date) values ($1, $2, current_date)",
    [electionId, `Signals ${electionId}`],
  );
  await admin.query(
    "insert into public.booths (id, election_id, name, location) values ($1, $2, 'Hall', 'A')",
    [boothId, electionId],
  );
  const po = actorFor(
    await createStaffFixture(admin, [{ role: "presiding_officer", electionId, boothId }]),
  );
  await admin.query(
    "update public.elections set status = 'frozen', frozen_at = now(), freeze_count = 1 where id = $1",
    [electionId],
  );
  return { electionId, boothId, po };
}

const gw = (actor: Actor): Partial<GatewayDeps> => ({
  db: app,
  now,
  authenticate: async () => actor,
  appendAudit: appendAuditEvent,
});

describe("publish after commit", () => {
  const touch = (bus: MemorySignalBus, fail: boolean) =>
    defineCommand({
      name: "test.touch_booth",
      input: z.object({ boothId: z.uuid() }),
      authorize: (actor, input) => boothGrant(actor, input.boothId),
      describeTarget: (input) => ({
        electionId: null,
        target: { type: "booth", id: input.boothId },
      }),
      async execute(ctx, input) {
        const before = bus.published.length;
        await signalAfterCommit(ctx, bus, input.boothId, "booth-state-changed");
        if (bus.published.length !== before) throw new Error("signal sent before commit");
        if (fail) throw new CommandError("lifecycle", "forced failure");
        return {
          result: null,
          audit: {
            electionId: ctx.grant.electionId,
            target: { type: "booth", id: input.boothId },
            before: null,
            after: null,
          },
        };
      },
    });

  it("sends the signal with the new version only after the transaction commits", async () => {
    const b = await booth();
    const bus = new MemorySignalBus();
    await executeCommand(touch(bus, false), { boothId: b.boothId }, gw(b.po));
    expect(bus.published).toEqual([
      { boothId: b.boothId, signal: { type: "booth-state-changed", version: 1 } },
    ]);
    await executeCommand(touch(bus, false), { boothId: b.boothId }, gw(b.po));
    expect(bus.published.map((p) => p.signal.version)).toEqual([1, 2]);
  });

  it("sends nothing and keeps the version when the transaction rolls back (negative test)", async () => {
    const b = await booth();
    const bus = new MemorySignalBus();
    await expect(
      executeCommand(touch(bus, true), { boothId: b.boothId }, gw(b.po)),
    ).rejects.toThrow("forced failure");
    expect(bus.published).toEqual([]);
    const { rows } = await app.query(
      "select version from public.booth_state_versions where booth_id = $1",
      [b.boothId],
    );
    expect(rows).toEqual([]);
  });

  it("a publish failure after commit does not fail or undo the command", async () => {
    const b = await booth();
    const failing = { publish: async () => Promise.reject(new Error("realtime down")) };
    const cmd = defineCommand({
      name: "test.touch_booth",
      input: z.object({ boothId: z.uuid() }),
      authorize: (actor, input) => boothGrant(actor, input.boothId),
      describeTarget: (input) => ({
        electionId: null,
        target: { type: "booth", id: input.boothId },
      }),
      async execute(ctx, input) {
        await signalAfterCommit(ctx, failing, input.boothId, "booth-state-changed");
        return {
          result: "ok",
          audit: {
            electionId: ctx.grant.electionId,
            target: { type: "booth", id: input.boothId },
            before: null,
            after: null,
          },
        };
      },
    });
    await expect(executeCommand(cmd, { boothId: b.boothId }, gw(b.po))).resolves.toBe("ok");
  });
});

describe("terminal state endpoint", () => {
  const stateDeps = () => ({ db: app, now, appendAudit: appendAuditEvent });
  let ipCounter = 0;

  async function pairedBooth() {
    const b = await booth();
    const bus = new MemorySignalBus();
    const commands = createTerminalCommands(bus);
    const master = await executeCommand(commands.registerMaster, { boothId: b.boothId }, gw(b.po));
    const { code, codeId } = await executeCommand(
      commands.generatePairingCode,
      { boothId: b.boothId, masterToken: master.token },
      gw(b.po),
    );
    const deps: PairingDeps = { db: app, now, appendAudit: appendAuditEvent, publisher: bus };
    const nonce = newCredentialToken();
    await submitPairingCode(deps, { code, ip: `10.9.0.${++ipCounter}`, nonce });
    await executeCommand(
      commands.confirmPairing,
      { boothId: b.boothId, masterToken: master.token, codeId, deviceId: deviceIdFor(nonce) },
      gw(b.po),
    );
    const voting = await collectPairing(deps, { nonce });
    if (voting.status !== "paired") throw new Error("pairing failed");
    return { ...b, masterTerminalId: master.terminalId, votingTerminalId: voting.terminalId };
  }

  const asTerminal = (
    b: { electionId: string; boothId: string },
    id: string,
    type: "master" | "voting",
  ) => ({ id, electionId: b.electionId, boothId: b.boothId, type, deviceId: null });

  it("gives a Voting Terminal state and version but never a count or choice data", async () => {
    clock = new Date();
    const b = await pairedBooth();
    await admin.query(
      "create table if not exists public.ballot_sessions (booth_id uuid not null, status text not null, is_mock boolean not null default false)",
    );
    await admin.query("grant select on public.ballot_sessions to app_server");
    await admin.query(
      "insert into public.ballot_sessions values ($1, 'cast', false), ($1, 'cast', false), ($1, 'pending', false)",
      [b.boothId],
    );
    try {
      const voting = await getTerminalState(
        stateDeps(),
        asTerminal(b, b.votingTerminalId, "voting"),
      );
      expect(Object.keys(voting).sort()).toEqual([
        "ballotPending",
        "boothState",
        "role",
        "version",
      ]);
      expect(voting).toMatchObject({ role: "voting", ballotPending: true, boothState: "frozen" });
      expect(JSON.stringify(voting)).not.toMatch(
        /count|cast|candidate|choice|nota|selection|total/i,
      );

      const master = await getTerminalState(
        stateDeps(),
        asTerminal(b, b.masterTerminalId, "master"),
      );
      expect(master).toMatchObject({ role: "master", ballotsCast: 2, ballotPending: true });
    } finally {
      await admin.query("drop table public.ballot_sessions");
    }
  });

  it("derives online/offline from heartbeats (clock-mocked) and audits going offline once", async () => {
    clock = new Date();
    const b = await pairedBooth();
    const master = asTerminal(b, b.masterTerminalId, "master");
    const votingStatus = async () =>
      (
        (await getTerminalState(stateDeps(), master)) as {
          votingTerminal: { online: boolean; lastSeenAt: string | null };
        }
      ).votingTerminal;

    expect((await votingStatus()).online).toBe(false); // never seen
    await recordHeartbeat(app, b.votingTerminalId, clock);
    expect(await votingStatus()).toMatchObject({ online: true, lastSeenAt: clock.toISOString() });

    clock = new Date(clock.getTime() + OFFLINE_AFTER_MS - 1000);
    expect((await votingStatus()).online).toBe(true);
    clock = new Date(clock.getTime() + 2000);
    expect((await votingStatus()).online).toBe(false);
    expect((await votingStatus()).online).toBe(false); // observed again: not audited again

    const events = await auditEvents(app, {
      electionId: b.electionId,
      eventType: "terminal.went_offline",
    });
    expect(events).toHaveLength(1);

    await recordHeartbeat(app, b.votingTerminalId, clock);
    expect((await votingStatus()).online).toBe(true);
    clock = new Date();
  });

  it("reports the live pairing code and a waiting device to the Master Terminal", async () => {
    clock = new Date();
    const b = await booth();
    const bus = new MemorySignalBus();
    const commands = createTerminalCommands(bus);
    const master = await executeCommand(commands.registerMaster, { boothId: b.boothId }, gw(b.po));
    const terminal = asTerminal(b, master.terminalId, "master");
    const pairing = async () =>
      ((await getTerminalState(stateDeps(), terminal)) as { pairing: unknown }).pairing;

    expect(await pairing()).toBeNull();
    const { code } = await executeCommand(
      commands.generatePairingCode,
      { boothId: b.boothId, masterToken: master.token },
      gw(b.po),
    );
    expect(await pairing()).toMatchObject({ status: "active", deviceId: null });
    const nonce = newCredentialToken();
    await submitPairingCode(
      { db: app, now, appendAudit: appendAuditEvent, publisher: bus },
      { code, ip: `10.9.1.${++ipCounter}`, nonce },
    );
    expect(await pairing()).toMatchObject({ status: "pending", deviceId: deviceIdFor(nonce) });
  });
});

describe("channel tokens", () => {
  const terminal = { id: randomUUID(), boothId: randomUUID(), type: "voting" as const };

  it("are booth-scoped, signed and valid for 15 minutes", () => {
    const at = new Date("2026-10-09T10:00:00Z");
    const { token, expiresAt } = mintChannelToken(jwtSecret, terminal, at);
    expect(expiresAt.getTime() - at.getTime()).toBe(CHANNEL_TOKEN_TTL_SECONDS * 1000);
    expect(CHANNEL_TOKEN_TTL_SECONDS).toBe(900);
    expect(verifyChannelToken(jwtSecret, token, at)).toMatchObject({
      booth_id: terminal.boothId,
      terminal_id: terminal.id,
      terminal_type: "voting",
      role: "authenticated",
    });
    expect(
      verifyChannelToken(jwtSecret, token, new Date(at.getTime() + 15 * 60 * 1000 + 1000)),
    ).toBeNull();
    expect(verifyChannelToken("another-secret-another-secret-another", token, at)).toBeNull();

    const [h, p, s] = token.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as object;
    const forged = Buffer.from(JSON.stringify({ ...claims, booth_id: randomUUID() })).toString(
      "base64url",
    );
    expect(verifyChannelToken(jwtSecret, `${h}.${forged}.${s}`, at)).toBeNull();
  });
});

const realtimeUrl = `${supabaseUrl.replace(/^http/, "ws")}/realtime/v1`;
const publisher = supabasePublisher({ supabaseUrl, secretKey });
const subscriber = supabaseSubscriber({ realtimeUrl, apiKey });

describeSignalBusContract("Supabase Realtime (local stack)", async () => ({
  bus: { publish: publisher.publish, subscribe: subscriber.subscribe },
  tokenFor: (boothId) =>
    mintChannelToken(jwtSecret, { id: randomUUID(), boothId, type: "voting" }, new Date()).token,
  quietMs: 600,
}));

describe("Realtime authorization (local stack)", () => {
  it("a terminal cannot publish to its own booth channel (negative test)", async () => {
    const boothId = randomUUID();
    const mk = (type: "master" | "voting") =>
      mintChannelToken(jwtSecret, { id: randomUUID(), boothId, type }, new Date()).token;
    const received: unknown[] = [];
    let listening = false;
    const sub = subscriber.subscribe(
      { boothId, token: mk("master") },
      { onSignal: (s) => received.push(s), onStatus: (s) => (listening = s === "connected") },
    );
    for (let i = 0; i < 100 && !listening; i++) await new Promise((r) => setTimeout(r, 50));
    expect(listening).toBe(true);

    // A second terminal of the same booth tries to broadcast on the channel.
    const attacker = new RealtimeClient(realtimeUrl, {
      params: { apikey: apiKey },
      accessToken: async () => mk("voting"),
    });
    const channel = attacker.channel(`booth:${boothId}`, { config: { private: true } });
    await new Promise<void>((resolve) => channel.subscribe(() => resolve()));
    await channel
      .send({
        type: "broadcast",
        event: "signal",
        payload: { type: "ballot-enabled", version: 99 },
      })
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1000));
    expect(received).toEqual([]);

    sub.unsubscribe();
    await attacker.removeChannel(channel);
    attacker.disconnect();
  });

  it("a token without booth claims receives nothing (negative test)", async () => {
    const boothId = randomUUID();
    // Same signing key and role, but no booth_id / terminal_type claims (like a staff token).
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const iat = Math.floor(Date.now() / 1000);
    const body = Buffer.from(
      JSON.stringify({
        aud: "authenticated",
        role: "authenticated",
        sub: randomUUID(),
        iat,
        exp: iat + 600,
      }),
    ).toString("base64url");
    const sig = createHmac("sha256", jwtSecret).update(`${header}.${body}`).digest("base64url");
    const got: unknown[] = [];
    const statuses: string[] = [];
    const sub = subscriber.subscribe(
      { boothId, token: `${header}.${body}.${sig}` },
      { onSignal: (s) => got.push(s), onStatus: (s) => statuses.push(s) },
    );
    await new Promise((r) => setTimeout(r, 1200));
    await publisher.publish(boothId, { type: "ballot-cast", version: 1 });
    await new Promise((r) => setTimeout(r, 600));
    expect(got).toEqual([]);
    expect(statuses).not.toContain("connected");
    sub.unsubscribe();
  });
});
