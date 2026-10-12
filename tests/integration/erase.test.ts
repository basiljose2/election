import { afterAll, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import type { Actor } from "@/lib/auth/roles";
import { CommandError } from "@/lib/commands/errors";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { ERASE_PHRASE, eraseAllData, getEraseStatus } from "@/lib/commands/system";
import { actorFor, adminPool, appPool, createStaffFixture } from "../support/fixtures";
import { buildVotingWorld } from "../support/voting-world";

const app = appPool();
const admin = adminPool();

afterAll(async () => {
  await admin.query("update public.deployment_settings set allow_data_erase = false");
  await Promise.all([app.end(), admin.end()]);
});

const gw = (actor: Actor): Partial<GatewayDeps> => ({
  db: app,
  now: () => new Date(),
  authenticate: async () => actor,
  appendAudit: appendAuditEvent,
});
const erase = (actor: Actor, confirmation: string = ERASE_PHRASE) =>
  executeCommand(eraseAllData, { confirmation }, gw(actor));
const code = (e: unknown) => (e instanceof CommandError ? e.code : String(e));
const count = async (table: string) =>
  Number((await admin.query(`select count(*) n from public.${table}`)).rows[0].n);
const setAllowed = (value: boolean) =>
  admin.query("update public.deployment_settings set allow_data_erase = $1", [value]);

describe("erasing all election data (test databases only)", () => {
  it("is off by default, and the application cannot switch it on", async () => {
    await setAllowed(false);
    expect((await getEraseStatus(app)).allowed).toBe(false);
    await expect(
      app.query("update public.deployment_settings set allow_data_erase = true"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("select public.erase_all_election_data()")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("refuses everything unless the database owner switched it on", async () => {
    await setAllowed(false);
    const w = await buildVotingWorld(admin);
    const sa = actorFor(await createStaffFixture(admin, [{ role: "super_admin" }]));
    const before = await count("elections");

    await expect(erase(sa)).rejects.toSatisfy(
      (e) => code(e) === "lifecycle" && /not enabled for this database/.test((e as Error).message),
    );
    expect(await count("elections")).toBe(before);
    expect(await count("elections")).toBeGreaterThan(0);
    void w;
  });

  it("needs a Super Admin, a fresh re-authentication and the typed phrase", async () => {
    await setAllowed(true);
    const w = await buildVotingWorld(admin);
    const sa = actorFor(await createStaffFixture(admin, [{ role: "super_admin" }]));
    const before = await count("elections");

    for (const actor of [w.ro, w.po]) {
      await expect(erase(actor)).rejects.toSatisfy((e) => code(e) === "forbidden");
    }
    await expect(erase(sa, "erase all data")).rejects.toSatisfy((e) => code(e) === "invalid_input");
    await expect(erase(sa, "")).rejects.toSatisfy((e) => code(e) === "invalid_input");
    const stale = Math.floor(Date.now() / 1000) - 3600;
    await expect(erase({ ...sa, authTimes: { password: stale, totp: stale } })).rejects.toSatisfy(
      (e) => code(e) === "reauth_required",
    );
    expect(await count("elections")).toBe(before);
  });

  it("erases elections, votes and the audit log, keeps staff, and records itself first", async () => {
    await setAllowed(true);
    const w = await buildVotingWorld(admin);
    const sa = actorFor(await createStaffFixture(admin, [{ role: "super_admin" }]));
    expect(await count("elections")).toBeGreaterThan(0);
    expect(await count("audit_events")).toBeGreaterThan(0);
    const staffBefore = await count("staff");

    const counts = await erase(sa);
    expect(counts.elections).toBeGreaterThan(0);
    expect(counts.audit_events).toBeGreaterThan(0);

    for (const table of [
      "elections",
      "booths",
      "posts",
      "candidates",
      "terminals",
      "ballot_sessions",
      "vote_selections",
      "booth_tallies",
      "results",
      "verification_bundles",
      "election_signing_keys",
    ]) {
      expect(await count(table), table).toBe(0);
    }

    // The reference tables of permitted transitions are not election data and stay.
    expect(await count("election_transitions")).toBe(6);
    expect(await count("booth_transitions")).toBe(6);

    // Staff accounts and Super Admin roles stay; election-scoped roles are gone.
    expect(await count("staff")).toBe(staffBefore);
    const roles = await admin.query("select distinct role::text r from public.staff_roles");
    expect(roles.rows).toEqual([{ r: "super_admin" }]);
    const kept = await admin.query(
      "select 1 from public.staff_roles where user_id = $1 and role = 'super_admin'",
      [sa.userId],
    );
    expect(kept.rows).toHaveLength(1);
    void w;

    // The audit log restarted: the erase itself is event 1 of the system chain.
    const events = await admin.query(
      "select seq, payload from public.audit_events order by chain_key, seq",
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].payload).toMatchObject({
      event_type: "system.data_erased",
      actor: { user_id: sa.userId, role: "super_admin" },
      after: { erased: true },
    });
    expect(Number(events.rows[0].seq)).toBe(1);
    expect(JSON.stringify(events.rows[0].payload.before)).toMatch(/vote_rows/);

    // The database is usable afterwards: a new election works from scratch.
    const again = await buildVotingWorld(admin);
    expect(again.electionId).toBeTruthy();
    expect(await count("elections")).toBe(1);
    await setAllowed(false);
  });
});
