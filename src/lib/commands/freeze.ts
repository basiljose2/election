import { z } from "zod";
import type { Tx } from "@/lib/db/pool";
import { buildFrozenSetup, validateFreeze, type Violation } from "@/lib/setup/freeze";
import { loadSetupData } from "@/lib/setup/load";
import { CommandError } from "./errors";
import { defineCommand } from "./gateway";
import { describeElection, pgCode, returningOfficerGrant, uuid } from "./setup-common";

/** A freeze that failed validation; carries every violation, not just the first. */
export class FreezeValidationError extends CommandError {
  constructor(readonly violations: Violation[]) {
    super("lifecycle", `Cannot freeze: ${violations.map((v) => v.message).join("; ")}`);
    this.name = "FreezeValidationError";
  }
}

async function lockElection(tx: Tx, electionId: string) {
  const { rows } = await tx.query<{ status: "draft" | "frozen"; freeze_count: number }>(
    "select status, freeze_count from public.elections where id = $1 for update",
    [electionId],
  );
  if (!rows[0]) throw new CommandError("not_found", "Election not found");
  return rows[0];
}

/**
 * Freeze: validate → mark uncontested Posts → assign serials and write one Ballot Definition
 * per booth plus the Setup Hash snapshot → Frozen. Critical (recent re-authentication).
 */
export const freezeSetup = defineCommand({
  name: "election.frozen",
  input: z.object({ electionId: uuid }),
  critical: true,
  authorize: (actor, input) => returningOfficerGrant(actor, input.electionId),
  describeTarget: describeElection,
  async validate({ tx }, input) {
    const election = await lockElection(tx, input.electionId);
    if (election.status !== "draft") {
      throw new CommandError("lifecycle", "The setup is already frozen");
    }
    const violations = validateFreeze(await loadSetupData(tx, input.electionId));
    if (violations.length > 0) throw new FreezeValidationError(violations);
  },
  async execute({ tx }, input) {
    const election = await lockElection(tx, input.electionId);
    const freezeNumber = election.freeze_count + 1;
    const data = await loadSetupData(tx, input.electionId);
    const frozen = buildFrozenSetup(data, freezeNumber);

    // Posts are marked while the Election is still Draft (the Draft-only triggers).
    await tx.query(
      "update public.posts set uncontested = (id = any($2::uuid[])) where election_id = $1",
      [input.electionId, frozen.uncontestedPostIds],
    );
    await tx.query(
      `insert into public.setup_snapshots (election_id, freeze_no, canonical_json, setup_hash)
       values ($1, $2, $3, $4)`,
      [input.electionId, freezeNumber, frozen.canonicalJson, frozen.setupHash],
    );
    for (const def of frozen.definitions) {
      await tx.query(
        `insert into public.ballot_definitions
           (election_id, freeze_no, booth_id, canonical_json, definition_hash)
         values ($1, $2, $3, $4, $5)`,
        [input.electionId, freezeNumber, def.boothId, def.canonicalJson, def.hash],
      );
    }
    await tx.query(
      `update public.elections
          set status = 'frozen', frozen_at = now(), freeze_count = $2
        where id = $1`,
      [input.electionId, freezeNumber],
    );

    return {
      result: { freezeNumber, setupHash: frozen.setupHash },
      audit: {
        electionId: input.electionId,
        target: { type: "election", id: input.electionId },
        before: { status: "draft" },
        after: { status: "frozen", freeze_number: freezeNumber, setup_hash: frozen.setupHash },
        detail: {
          booth_definitions: frozen.definitions.map((d) => ({
            booth_id: d.boothId,
            definition_hash: d.hash,
          })),
          uncontested_post_ids: frozen.uncontestedPostIds,
        },
      },
    };
  },
});

/**
 * Unfreeze: only while no Ballot Session (mock or real) has ever been issued in the Election.
 * Snapshots are append-only and stay as history; a later freeze appends a new generation.
 */
export const unfreezeSetup = defineCommand({
  name: "election.unfrozen",
  input: z.object({ electionId: uuid }),
  critical: true,
  authorize: (actor, input) => returningOfficerGrant(actor, input.electionId),
  describeTarget: describeElection,
  async validate({ tx }, input) {
    const election = await lockElection(tx, input.electionId);
    if (election.status !== "frozen") {
      throw new CommandError("lifecycle", "The setup is not frozen");
    }
    const { rows } = await tx.query<{ issued: boolean }>(
      "select public.election_has_ballot_session($1) as issued",
      [input.electionId],
    );
    if (rows[0]!.issued) {
      throw new CommandError(
        "lifecycle",
        "Cannot unfreeze: a Ballot Session has already been issued in this Election",
      );
    }
  },
  async execute({ tx }, input) {
    const snapshot = await tx.query<{ freeze_no: number; setup_hash: string }>(
      `select freeze_no, setup_hash from public.setup_snapshots
        where election_id = $1 order by freeze_no desc limit 1`,
      [input.electionId],
    );
    try {
      await tx.query(
        "update public.elections set status = 'draft', frozen_at = null where id = $1",
        [input.electionId],
      );
    } catch (error) {
      if (pgCode(error) === "P0001") {
        throw new CommandError("lifecycle", "Cannot unfreeze: a Ballot Session has been issued");
      }
      throw error;
    }
    await tx.query("update public.posts set uncontested = false where election_id = $1", [
      input.electionId,
    ]);
    return {
      result: { electionId: input.electionId },
      audit: {
        electionId: input.electionId,
        target: { type: "election", id: input.electionId },
        before: {
          status: "frozen",
          freeze_number: snapshot.rows[0]?.freeze_no ?? null,
          setup_hash: snapshot.rows[0]?.setup_hash ?? null,
        },
        after: { status: "draft" },
      },
    };
  },
});
