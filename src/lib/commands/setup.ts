import { z } from "zod";
import { processImage } from "@/lib/media/images";
import type { ImageStore } from "@/lib/media/store";
import { defineCommand, type CommandContext } from "./gateway";
import { CommandError } from "./errors";
import {
  assertPermutation,
  describeElection,
  guarded,
  nameField,
  requireDraftElection,
  returningOfficerGrant,
  uuid,
} from "./setup-common";

/**
 * Draft-only setup commands for Posts, Candidates, Polling Booths and the Booth-Post mapping.
 * Every input carries the electionId; every row is looked up *within* that Election, so an
 * id belonging to another Election is "not found" and can never be changed through a grant
 * for this one.
 */

const authorize = (
  actor: Parameters<typeof returningOfficerGrant>[0],
  input: { electionId: string },
) => returningOfficerGrant(actor, input.electionId);

const draftOnly = async ({ tx }: CommandContext, input: { electionId: string }) =>
  requireDraftElection(tx, input.electionId);

const seats = z
  .number({ error: "Seats must be a whole number" })
  .int("Seats must be a whole number")
  .min(1, "A Post needs at least 1 seat")
  .max(100);

const SEATS_MESSAGE = "A Post needs at least 1 seat";
const POST_NAME_TAKEN = "A Post with this name already exists in this Election";
const CANDIDATE_NAME_TAKEN = "A Candidate with this name already exists for this Post";
const BOOTH_NAME_TAKEN = "A Polling Booth with this name already exists in this Election";

async function requirePost(ctx: CommandContext, electionId: string, postId: string) {
  const { rows } = await ctx.tx.query<{ id: string; name: string; seats: number }>(
    "select id, name, seats from public.posts where id = $1 and election_id = $2 for update",
    [postId, electionId],
  );
  if (!rows[0]) throw new CommandError("not_found", "Post not found");
  return rows[0];
}

async function requireCandidate(ctx: CommandContext, electionId: string, candidateId: string) {
  const { rows } = await ctx.tx.query<{
    id: string;
    post_id: string;
    name: string;
    photo_hash: string | null;
    symbol_hash: string | null;
    symbol_text: string | null;
  }>(
    `select id, post_id, name, photo_hash, symbol_hash, symbol_text
       from public.candidates where id = $1 and election_id = $2 for update`,
    [candidateId, electionId],
  );
  if (!rows[0]) throw new CommandError("not_found", "Candidate not found");
  return rows[0];
}

async function requireBooth(ctx: CommandContext, electionId: string, boothId: string) {
  const { rows } = await ctx.tx.query<{ id: string; name: string; location: string }>(
    "select id, name, location from public.booths where id = $1 and election_id = $2 for update",
    [boothId, electionId],
  );
  if (!rows[0]) throw new CommandError("not_found", "Polling Booth not found");
  return rows[0];
}

// ------------------------------------------------------------------------- Posts

export const createPost = defineCommand({
  name: "post.created",
  input: z.object({ electionId: uuid, name: nameField, seats }),
  authorize,
  describeTarget: describeElection,
  validate: draftOnly,
  async execute({ tx }, input) {
    const { rows } = await guarded({ unique: POST_NAME_TAKEN, check: SEATS_MESSAGE }, () =>
      tx.query<{ id: string }>(
        `insert into public.posts (election_id, name, seats, display_order)
         values ($1, $2, $3,
                 (select coalesce(max(display_order) + 1, 0) from public.posts where election_id = $1))
         returning id`,
        [input.electionId, input.name, input.seats],
      ),
    );
    const id = rows[0]!.id;
    return {
      result: { postId: id },
      audit: {
        electionId: input.electionId,
        target: { type: "post", id },
        before: null,
        after: { name: input.name, seats: input.seats },
      },
    };
  },
});

export const updatePost = defineCommand({
  name: "post.updated",
  input: z.object({ electionId: uuid, postId: uuid, name: nameField, seats }),
  authorize,
  describeTarget: describeElection,
  validate: draftOnly,
  async execute(ctx, input) {
    const before = await requirePost(ctx, input.electionId, input.postId);
    await guarded({ unique: POST_NAME_TAKEN, check: SEATS_MESSAGE }, () =>
      ctx.tx.query("update public.posts set name = $2, seats = $3 where id = $1", [
        input.postId,
        input.name,
        input.seats,
      ]),
    );
    return {
      result: { postId: input.postId },
      audit: {
        electionId: input.electionId,
        target: { type: "post", id: input.postId },
        before: { name: before.name, seats: before.seats },
        after: { name: input.name, seats: input.seats },
      },
    };
  },
});

export const deletePost = defineCommand({
  name: "post.deleted",
  input: z.object({ electionId: uuid, postId: uuid }),
  authorize,
  describeTarget: describeElection,
  validate: draftOnly,
  async execute(ctx, input) {
    const before = await requirePost(ctx, input.electionId, input.postId);
    const removed = await ctx.tx.query(
      "delete from public.candidates where post_id = $1 and election_id = $2",
      [input.postId, input.electionId],
    );
    await ctx.tx.query("delete from public.booth_posts where post_id = $1", [input.postId]);
    await ctx.tx.query("delete from public.posts where id = $1", [input.postId]);
    return {
      result: { postId: input.postId },
      audit: {
        electionId: input.electionId,
        target: { type: "post", id: input.postId },
        before: { name: before.name, seats: before.seats },
        after: null,
        detail: { candidates_removed: removed.rowCount ?? 0 },
      },
    };
  },
});

export const reorderPosts = defineCommand({
  name: "post.reordered",
  input: z.object({ electionId: uuid, orderedIds: z.array(uuid).min(1) }),
  authorize,
  describeTarget: describeElection,
  validate: draftOnly,
  async execute({ tx }, input) {
    const current = await tx.query<{ id: string }>(
      "select id from public.posts where election_id = $1 order by display_order, id for update",
      [input.electionId],
    );
    assertPermutation(
      input.orderedIds,
      current.rows.map((r) => r.id),
      "Post",
    );
    await tx.query(
      `update public.posts p set display_order = o.pos - 1
         from unnest($2::uuid[]) with ordinality as o(id, pos)
        where p.id = o.id and p.election_id = $1`,
      [input.electionId, input.orderedIds],
    );
    return {
      result: { electionId: input.electionId },
      audit: {
        electionId: input.electionId,
        target: { type: "election", id: input.electionId },
        before: { post_order: current.rows.map((r) => r.id) },
        after: { post_order: input.orderedIds },
      },
    };
  },
});

// ------------------------------------------------------------------- Candidates

const symbolText = z
  .string()
  .trim()
  .max(40, "A text symbol is at most 40 characters")
  .transform((v) => (v === "" ? null : v))
  .nullish()
  .transform((v) => v ?? null);

export const createCandidate = defineCommand({
  name: "candidate.created",
  input: z.object({ electionId: uuid, postId: uuid, name: nameField, symbolText }),
  authorize,
  describeTarget: describeElection,
  validate: draftOnly,
  async execute(ctx, input) {
    await requirePost(ctx, input.electionId, input.postId);
    const { rows } = await guarded({ unique: CANDIDATE_NAME_TAKEN }, () =>
      ctx.tx.query<{ id: string }>(
        `insert into public.candidates (election_id, post_id, name, symbol_text, sort_order)
         values ($1, $2, $3, $4,
                 (select coalesce(max(sort_order) + 1, 0) from public.candidates where post_id = $2))
         returning id`,
        [input.electionId, input.postId, input.name, input.symbolText],
      ),
    );
    const id = rows[0]!.id;
    return {
      result: { candidateId: id },
      audit: {
        electionId: input.electionId,
        target: { type: "candidate", id },
        before: null,
        after: { post_id: input.postId, name: input.name, symbol_text: input.symbolText },
      },
    };
  },
});

export const updateCandidate = defineCommand({
  name: "candidate.updated",
  input: z.object({ electionId: uuid, candidateId: uuid, name: nameField, symbolText }),
  authorize,
  describeTarget: describeElection,
  validate: draftOnly,
  async execute(ctx, input) {
    const before = await requireCandidate(ctx, input.electionId, input.candidateId);
    // A symbol is either text or an image: giving text replaces any symbol image.
    const symbolHash = input.symbolText !== null ? null : before.symbol_hash;
    await guarded({ unique: CANDIDATE_NAME_TAKEN }, () =>
      ctx.tx.query(
        "update public.candidates set name = $2, symbol_text = $3, symbol_hash = $4 where id = $1",
        [input.candidateId, input.name, input.symbolText, symbolHash],
      ),
    );
    return {
      result: { candidateId: input.candidateId },
      audit: {
        electionId: input.electionId,
        target: { type: "candidate", id: input.candidateId },
        before: { name: before.name, symbol_text: before.symbol_text },
        after: { name: input.name, symbol_text: input.symbolText },
      },
    };
  },
});

export const deleteCandidate = defineCommand({
  name: "candidate.deleted",
  input: z.object({ electionId: uuid, candidateId: uuid }),
  authorize,
  describeTarget: describeElection,
  validate: draftOnly,
  async execute(ctx, input) {
    const before = await requireCandidate(ctx, input.electionId, input.candidateId);
    await ctx.tx.query("delete from public.candidates where id = $1", [input.candidateId]);
    return {
      result: { candidateId: input.candidateId },
      audit: {
        electionId: input.electionId,
        target: { type: "candidate", id: input.candidateId },
        before: { post_id: before.post_id, name: before.name },
        after: null,
      },
    };
  },
});

export const reorderCandidates = defineCommand({
  name: "candidate.reordered",
  input: z.object({ electionId: uuid, postId: uuid, orderedIds: z.array(uuid).min(1) }),
  authorize,
  describeTarget: describeElection,
  validate: draftOnly,
  async execute(ctx, input) {
    await requirePost(ctx, input.electionId, input.postId);
    const current = await ctx.tx.query<{ id: string }>(
      `select id from public.candidates where post_id = $1 and election_id = $2
        order by sort_order, id for update`,
      [input.postId, input.electionId],
    );
    assertPermutation(
      input.orderedIds,
      current.rows.map((r) => r.id),
      "Candidate",
    );
    await ctx.tx.query(
      `update public.candidates c set sort_order = o.pos - 1
         from unnest($2::uuid[]) with ordinality as o(id, pos)
        where c.id = o.id and c.post_id = $1`,
      [input.postId, input.orderedIds],
    );
    return {
      result: { postId: input.postId },
      audit: {
        electionId: input.electionId,
        target: { type: "post", id: input.postId },
        before: { candidate_order: current.rows.map((r) => r.id) },
        after: { candidate_order: input.orderedIds },
      },
    };
  },
});

/** Raw uploaded bytes; the server validates and re-encodes them. */
const imageBytes = z.custom<Uint8Array>(
  (v) => v instanceof Uint8Array,
  "An image file is required",
);

export function createMediaCommands(store: ImageStore) {
  const setCandidateMedia = defineCommand({
    name: "candidate.media_set",
    input: z.object({
      electionId: uuid,
      candidateId: uuid,
      kind: z.enum(["photo", "symbol"]),
      file: imageBytes,
    }),
    authorize,
    describeTarget: describeElection,
    validate: draftOnly,
    async execute(ctx, input) {
      const before = await requireCandidate(ctx, input.electionId, input.candidateId);
      const image = await processImage(input.file);
      await store.put(image.hash, image.bytes);
      if (input.kind === "photo") {
        await ctx.tx.query("update public.candidates set photo_hash = $2 where id = $1", [
          input.candidateId,
          image.hash,
        ]);
      } else {
        // A symbol is either text or an image: an image replaces any text symbol.
        await ctx.tx.query(
          "update public.candidates set symbol_hash = $2, symbol_text = null where id = $1",
          [input.candidateId, image.hash],
        );
      }
      return {
        result: { hash: image.hash },
        audit: {
          electionId: input.electionId,
          target: { type: "candidate", id: input.candidateId },
          before: { photo_hash: before.photo_hash, symbol_hash: before.symbol_hash },
          after:
            input.kind === "photo"
              ? { photo_hash: image.hash, symbol_hash: before.symbol_hash }
              : { photo_hash: before.photo_hash, symbol_hash: image.hash },
          detail: { kind: input.kind, bytes: image.bytes.byteLength },
        },
      };
    },
  });

  const clearCandidateMedia = defineCommand({
    name: "candidate.media_cleared",
    input: z.object({
      electionId: uuid,
      candidateId: uuid,
      kind: z.enum(["photo", "symbol"]),
    }),
    authorize,
    describeTarget: describeElection,
    validate: draftOnly,
    async execute(ctx, input) {
      const before = await requireCandidate(ctx, input.electionId, input.candidateId);
      const column = input.kind === "photo" ? "photo_hash" : "symbol_hash";
      await ctx.tx.query(`update public.candidates set ${column} = null where id = $1`, [
        input.candidateId,
      ]);
      return {
        result: { candidateId: input.candidateId },
        audit: {
          electionId: input.electionId,
          target: { type: "candidate", id: input.candidateId },
          before: { [column]: before[column] },
          after: { [column]: null },
        },
      };
    },
  });

  return { setCandidateMedia, clearCandidateMedia };
}

// ------------------------------------------------------------------------ Booths

const location = z.string().trim().min(1, "A location is required").max(300);

export const createBooth = defineCommand({
  name: "booth.created",
  input: z.object({ electionId: uuid, name: nameField, location }),
  authorize,
  describeTarget: describeElection,
  validate: draftOnly,
  async execute({ tx }, input) {
    const { rows } = await guarded({ unique: BOOTH_NAME_TAKEN }, () =>
      tx.query<{ id: string }>(
        "insert into public.booths (election_id, name, location) values ($1, $2, $3) returning id",
        [input.electionId, input.name, input.location],
      ),
    );
    const id = rows[0]!.id;
    return {
      result: { boothId: id },
      audit: {
        electionId: input.electionId,
        target: { type: "booth", id },
        before: null,
        after: { name: input.name, location: input.location },
      },
    };
  },
});

export const updateBooth = defineCommand({
  name: "booth.updated",
  input: z.object({ electionId: uuid, boothId: uuid, name: nameField, location }),
  authorize,
  describeTarget: describeElection,
  validate: draftOnly,
  async execute(ctx, input) {
    const before = await requireBooth(ctx, input.electionId, input.boothId);
    await guarded({ unique: BOOTH_NAME_TAKEN }, () =>
      ctx.tx.query("update public.booths set name = $2, location = $3 where id = $1", [
        input.boothId,
        input.name,
        input.location,
      ]),
    );
    return {
      result: { boothId: input.boothId },
      audit: {
        electionId: input.electionId,
        target: { type: "booth", id: input.boothId },
        before: { name: before.name, location: before.location },
        after: { name: input.name, location: input.location },
      },
    };
  },
});

export const deleteBooth = defineCommand({
  name: "booth.deleted",
  input: z.object({ electionId: uuid, boothId: uuid }),
  authorize,
  describeTarget: describeElection,
  validate: draftOnly,
  async execute(ctx, input) {
    const before = await requireBooth(ctx, input.electionId, input.boothId);
    await ctx.tx.query("delete from public.booth_posts where booth_id = $1", [input.boothId]);
    await guarded(
      { foreignKey: "Revoke this booth's Presiding Officer assignment before deleting it" },
      () => ctx.tx.query("delete from public.booths where id = $1", [input.boothId]),
    );
    return {
      result: { boothId: input.boothId },
      audit: {
        electionId: input.electionId,
        target: { type: "booth", id: input.boothId },
        before: { name: before.name, location: before.location },
        after: null,
      },
    };
  },
});

/** Replaces the set of Posts a booth votes on (one row of the Booth-Post mapping matrix). */
export const setBoothPosts = defineCommand({
  name: "booth.posts_mapped",
  input: z.object({
    electionId: uuid,
    boothId: uuid,
    postIds: z.array(uuid).transform((ids) => [...new Set(ids)]),
  }),
  authorize,
  describeTarget: describeElection,
  validate: draftOnly,
  async execute(ctx, input) {
    await requireBooth(ctx, input.electionId, input.boothId);
    const valid = await ctx.tx.query<{ id: string }>(
      "select id from public.posts where election_id = $1 and id = any($2::uuid[])",
      [input.electionId, input.postIds],
    );
    if (valid.rows.length !== input.postIds.length) {
      throw new CommandError("not_found", "Post not found in this Election");
    }
    const before = await ctx.tx.query<{ post_id: string }>(
      "select post_id from public.booth_posts where booth_id = $1 order by post_id",
      [input.boothId],
    );
    await ctx.tx.query("delete from public.booth_posts where booth_id = $1", [input.boothId]);
    for (const postId of input.postIds) {
      await ctx.tx.query(
        "insert into public.booth_posts (election_id, booth_id, post_id) values ($1, $2, $3)",
        [input.electionId, input.boothId, postId],
      );
    }
    return {
      result: { boothId: input.boothId },
      audit: {
        electionId: input.electionId,
        target: { type: "booth", id: input.boothId },
        before: { post_ids: before.rows.map((r) => r.post_id) },
        after: { post_ids: [...input.postIds].sort() },
      },
    };
  },
});
