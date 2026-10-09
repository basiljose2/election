import { z } from "zod";
import { electionGrant, type Actor, type RoleAssignment } from "@/lib/auth/roles";
import type { Tx } from "@/lib/db/pool";
import { CommandError } from "./errors";

export const uuid = z.uuid();

export const nameField = z.string().trim().min(1, "A name is required").max(200);

/** The Returning Officer of exactly this Election (Super Admins configure by assigning one). */
export function returningOfficerGrant(actor: Actor, electionId: string): RoleAssignment | null {
  return electionGrant(actor, electionId, ["returning_officer"]);
}

export function describeElection(input: { electionId: string }) {
  return { electionId: input.electionId, target: { type: "election", id: input.electionId } };
}

/**
 * Takes a share lock on the Election and requires it to be Draft. Freeze takes the same row
 * FOR UPDATE, so an edit and a freeze can never interleave. The database triggers enforce the
 * same rule; this check gives the caller a clear message first.
 */
export async function requireDraftElection(tx: Tx, electionId: string): Promise<void> {
  const { rows } = await tx.query<{ status: string }>(
    "select status from public.elections where id = $1 for share",
    [electionId],
  );
  if (!rows[0]) throw new CommandError("not_found", "Election not found");
  if (rows[0].status !== "draft") {
    throw new CommandError(
      "lifecycle",
      "The setup is frozen. It can be edited only while the Election is in Draft",
    );
  }
}

export function pgCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Runs a write and translates database constraint errors into caller-safe messages.
 * `messages` maps SQLSTATE (or constraint name) to the text shown to the user.
 */
export async function guarded<T>(
  messages: { unique?: string; check?: string; foreignKey?: string },
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const code = pgCode(error);
    if (code === "23505" && messages.unique) throw new CommandError("conflict", messages.unique);
    if (code === "23514" && messages.check) throw new CommandError("invalid_input", messages.check);
    if (code === "23503" && messages.foreignKey) {
      throw new CommandError("conflict", messages.foreignKey);
    }
    if (code === "P0001") {
      throw new CommandError("lifecycle", "The setup is frozen and cannot be changed");
    }
    throw error;
  }
}

/** Validates that `orderedIds` is exactly the set `existing` (a complete permutation). */
export function assertPermutation(orderedIds: string[], existing: string[], what: string): void {
  const same =
    orderedIds.length === existing.length &&
    new Set(orderedIds).size === orderedIds.length &&
    existing.every((id) => orderedIds.includes(id));
  if (!same) {
    throw new CommandError("invalid_input", `The new order must list every ${what} exactly once`);
  }
}
