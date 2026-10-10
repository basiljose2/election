import { z } from "zod";
import { boothGrant, type Actor } from "@/lib/auth/roles";
import type { Tx } from "@/lib/db/pool";
import { signalAfterCommit } from "@/lib/signals/publish";
import type { SignalPublisher } from "@/lib/signals/types";
import {
  issueTerminal,
  revokeActiveTerminal,
  verifyTerminalCredential,
} from "@/lib/terminals/credentials";
import {
  codeHash,
  newCode,
  PAIRING_CODE_TTL_MS,
  PAIRING_CONFIRM_TTL_MS,
} from "@/lib/terminals/pairing";
import { CommandError } from "./errors";
import { defineCommand, type CommandContext } from "./gateway";
import { uuid } from "./setup-common";

/**
 * Presiding Officer commands for terminals. Each one needs BOTH the Presiding Officer's staff
 * session (authorize) and the booth's registered Master Terminal credential (validate), so
 * neither the login alone nor the device alone is enough. Registering the Master Terminal is
 * the exception: it is how the device gets its credential.
 */

const authorize = (actor: Actor, input: { boothId: string }) => boothGrant(actor, input.boothId);

const describeBooth = (input: { boothId: string }) => ({
  electionId: null,
  target: { type: "booth", id: input.boothId },
});

const masterToken = z.string().min(1, "This device is not registered as the Master Terminal");

async function boothElection(tx: Tx, boothId: string): Promise<string> {
  const { rows } = await tx.query<{ election_id: string }>(
    "select election_id from public.booths where id = $1",
    [boothId],
  );
  if (!rows[0]) throw new CommandError("not_found", "Polling Booth not found");
  return rows[0].election_id;
}

/** Terminals can be registered only while polling can happen, and never mid-ballot. */
async function requireTerminalsAllowed(tx: Tx, boothId: string): Promise<void> {
  const { rows } = await tx.query<{ accepts: boolean; pending: boolean }>(
    `select public.booth_accepts_terminals($1) as accepts,
            public.booth_has_pending_ballot_session($1) as pending`,
    [boothId],
  );
  if (!rows[0]!.accepts) {
    throw new CommandError(
      "lifecycle",
      "Terminals can be paired only while the Election is Frozen or Polling Open and the booth is not Closed",
    );
  }
  if (rows[0]!.pending) {
    throw new CommandError(
      "lifecycle",
      "A Ballot Session is pending at this booth; finish or cancel it before changing terminals",
    );
  }
}

async function requireMaster(ctx: CommandContext, boothId: string, token: string): Promise<string> {
  const check = await verifyTerminalCredential(ctx.tx, token, { type: "master", boothId });
  if (!check.ok) {
    throw new CommandError(
      "forbidden",
      "This device is not the registered Master Terminal of the booth",
    );
  }
  return check.terminal.id;
}

export function createTerminalCommands(publisher: SignalPublisher) {
  /** The signed-in Presiding Officer registers the device they are using as the booth's Master Terminal. */
  const registerMaster = defineCommand({
    name: "terminal.master_registered",
    input: z.object({ boothId: uuid }),
    authorize,
    describeTarget: describeBooth,
    async validate({ tx }, input) {
      await requireTerminalsAllowed(tx, input.boothId);
    },
    async execute(ctx, input) {
      const electionId = await boothElection(ctx.tx, input.boothId);
      const previous = await revokeActiveTerminal(ctx.tx, input.boothId, "master", "replaced");
      const { terminalId, token } = await issueTerminal(ctx.tx, {
        electionId,
        boothId: input.boothId,
        type: "master",
        registeredBy: ctx.actor.userId,
      });
      if (previous) {
        await signalAfterCommit(ctx, publisher, input.boothId, "terminal-revoked");
      } else {
        await signalAfterCommit(ctx, publisher, input.boothId, "booth-state-changed");
      }
      return {
        result: { terminalId, token },
        audit: {
          electionId,
          target: { type: "terminal", id: terminalId },
          before: null,
          after: { booth_id: input.boothId, type: "master" },
          detail: { replaced_terminal_id: previous },
        },
      };
    },
  });

  /** A fresh one-time code (6 digits, 2 minutes). Any earlier live code for the booth is invalidated. */
  const generatePairingCode = defineCommand({
    name: "pairing.code_generated",
    input: z.object({ boothId: uuid, masterToken }),
    authorize,
    describeTarget: describeBooth,
    async validate(ctx, input) {
      await requireMaster(ctx, input.boothId, input.masterToken);
      await requireTerminalsAllowed(ctx.tx, input.boothId);
    },
    async execute(ctx, input) {
      const electionId = await boothElection(ctx.tx, input.boothId);
      const superseded = await ctx.tx.query<{ id: string }>(
        `update public.pairing_codes set status = 'invalidated'
          where booth_id = $1 and status in ('active', 'pending', 'confirmed') returning id`,
        [input.boothId],
      );

      // The value must not equal another booth's live code, so a typed code reaches one booth.
      const live = await ctx.tx.query<{ id: string; code_hash: string }>(
        "select id, code_hash from public.pairing_codes where status = 'active' and expires_at > $1",
        [ctx.now()],
      );
      const id = crypto.randomUUID();
      let code = newCode();
      while (live.rows.some((row) => row.code_hash === codeHash(row.id, code))) code = newCode();

      const expiresAt = new Date(ctx.now().getTime() + PAIRING_CODE_TTL_MS);
      await ctx.tx.query(
        `insert into public.pairing_codes (id, election_id, booth_id, code_hash, expires_at, created_by)
         values ($1, $2, $3, $4, $5, $6)`,
        [id, electionId, input.boothId, codeHash(id, code), expiresAt, ctx.actor.userId],
      );
      await signalAfterCommit(ctx, publisher, input.boothId, "pairing-changed");
      return {
        result: { codeId: id, code, expiresAt },
        audit: {
          electionId,
          target: { type: "pairing_code", id },
          before: null,
          after: { booth_id: input.boothId, expires_at: expiresAt.toISOString() },
          detail: { superseded_codes: superseded.rows.length },
        },
      };
    },
  });

  const decide = (kind: "confirm" | "reject") =>
    defineCommand({
      name: kind === "confirm" ? "pairing.confirmed" : "pairing.rejected",
      input: z.object({
        boothId: uuid,
        masterToken,
        codeId: uuid,
        /** The identifier the Presiding Officer saw on the kiosk. */
        deviceId: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[0-9A-Z]{4}$/, "Enter the 4-character device id"),
      }),
      authorize,
      describeTarget: describeBooth,
      async validate(ctx, input) {
        await requireMaster(ctx, input.boothId, input.masterToken);
        if (kind === "confirm") await requireTerminalsAllowed(ctx.tx, input.boothId);
      },
      async execute(ctx, input) {
        const { rows } = await ctx.tx.query<{
          election_id: string;
          status: string;
          device_id: string | null;
          pending_expires_at: Date | null;
        }>(
          `select election_id, status, device_id, pending_expires_at from public.pairing_codes
            where id = $1 and booth_id = $2 for update`,
          [input.codeId, input.boothId],
        );
        const code = rows[0];
        if (!code) throw new CommandError("not_found", "Pairing request not found");
        if (code.status !== "pending") {
          throw new CommandError("lifecycle", "There is no device waiting to be confirmed");
        }
        if (!code.pending_expires_at || code.pending_expires_at <= ctx.now()) {
          await ctx.tx.query("update public.pairing_codes set status = 'expired' where id = $1", [
            input.codeId,
          ]);
          throw new CommandError("lifecycle", "The pairing request timed out; generate a new code");
        }
        if (code.device_id !== input.deviceId) {
          throw new CommandError(
            "conflict",
            "The device id does not match the device that is waiting; check the kiosk screen",
          );
        }
        await ctx.tx.query(
          `update public.pairing_codes set status = $2, pending_expires_at = $3 where id = $1`,
          [
            input.codeId,
            kind === "confirm" ? "confirmed" : "rejected",
            new Date(ctx.now().getTime() + PAIRING_CONFIRM_TTL_MS),
          ],
        );
        await signalAfterCommit(ctx, publisher, input.boothId, "pairing-changed");
        return {
          result: { codeId: input.codeId },
          audit: {
            electionId: code.election_id,
            target: { type: "pairing_code", id: input.codeId },
            before: { status: "pending", device_id: code.device_id },
            after: { status: kind === "confirm" ? "confirmed" : "rejected" },
          },
        };
      },
    });

  return {
    registerMaster,
    generatePairingCode,
    confirmPairing: decide("confirm"),
    rejectPairing: decide("reject"),
  };
}

export type TerminalCommands = ReturnType<typeof createTerminalCommands>;
