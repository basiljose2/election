import { z } from "zod";
import { superAdminGrant } from "@/lib/auth/roles";
import { loadElection } from "@/lib/setup/load";
import { randomUUID } from "node:crypto";
import { defineCommand } from "./gateway";
import { CommandError } from "./errors";
import {
  describeElection,
  guarded,
  nameField,
  requireDraftElection,
  returningOfficerGrant,
  uuid,
} from "./setup-common";

const pollingDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Polling date must be YYYY-MM-DD");
const description = z.string().trim().max(2000).default("");

/** Election-level commands: create, edit (Draft only) and clone for rehearsal. */
export const createElection = defineCommand({
  name: "election.created",
  input: z.object({
    name: nameField,
    description,
    pollingDate,
    notaEnabled: z.boolean().default(false),
  }),
  authorize: (actor) => superAdminGrant(actor),
  describeTarget: () => ({ electionId: null, target: { type: "election", id: "new" } }),
  async execute({ tx, actor }, input) {
    const { rows } = await guarded({ check: "That polling date is not valid" }, () =>
      tx.query<{ id: string }>(
        `insert into public.elections (name, description, polling_date, nota_enabled, created_by)
         values ($1, $2, $3, $4, $5) returning id`,
        [input.name, input.description, input.pollingDate, input.notaEnabled, actor.userId],
      ),
    );
    const id = rows[0]!.id;
    return {
      result: { electionId: id },
      audit: {
        electionId: id,
        target: { type: "election", id },
        before: null,
        after: {
          name: input.name,
          description: input.description,
          polling_date: input.pollingDate,
          nota_enabled: input.notaEnabled,
          status: "draft",
        },
      },
    };
  },
});

export const updateElection = defineCommand({
  name: "election.updated",
  input: z.object({
    electionId: uuid,
    name: nameField,
    description,
    pollingDate,
    notaEnabled: z.boolean(),
  }),
  authorize: (actor, input) => returningOfficerGrant(actor, input.electionId),
  describeTarget: describeElection,
  async validate({ tx }, input) {
    await requireDraftElection(tx, input.electionId);
  },
  async execute({ tx }, input) {
    const before = await loadElection(tx, input.electionId);
    await guarded({ check: "That polling date is not valid" }, () =>
      tx.query(
        `update public.elections
            set name = $2, description = $3, polling_date = $4, nota_enabled = $5
          where id = $1`,
        [input.electionId, input.name, input.description, input.pollingDate, input.notaEnabled],
      ),
    );
    return {
      result: { electionId: input.electionId },
      audit: {
        electionId: input.electionId,
        target: { type: "election", id: input.electionId },
        before: {
          name: before.name,
          description: before.description,
          polling_date: before.polling_date,
          nota_enabled: before.nota_enabled,
        },
        after: {
          name: input.name,
          description: input.description,
          polling_date: input.pollingDate,
          nota_enabled: input.notaEnabled,
        },
      },
    };
  },
});

/**
 * Copies an Election's setup (settings, Posts, Candidates, Polling Booths and mappings) into
 * a new Draft Election. Nothing that belongs to polling is copied: no Presiding Officer
 * assignments, Ballot Sessions, votes, terminals, snapshots or results.
 */
export const cloneElection = defineCommand({
  name: "election.cloned",
  input: z.object({
    sourceElectionId: uuid,
    name: nameField,
    pollingDate: pollingDate.optional(),
  }),
  authorize: (actor) => superAdminGrant(actor),
  describeTarget: (input) => ({
    electionId: input.sourceElectionId,
    target: { type: "election", id: input.sourceElectionId },
  }),
  async execute({ tx, actor }, input) {
    const source = await loadElection(tx, input.sourceElectionId).catch(() => {
      throw new CommandError("not_found", "Election to clone not found");
    });
    const { rows } = await tx.query<{ id: string }>(
      `insert into public.elections
         (name, description, polling_date, nota_enabled, cloned_from, created_by)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        input.name,
        source.description,
        input.pollingDate ?? source.polling_date,
        source.nota_enabled,
        source.id,
        actor.userId,
      ],
    );
    const newId = rows[0]!.id;

    // Fresh ids are generated here so rows can be inserted in dependency order.
    const ids = new Map<string, string>();
    const newIdFor = (oldId: string) => {
      const existing = ids.get(oldId);
      if (existing) return existing;
      const fresh = randomUUID();
      ids.set(oldId, fresh);
      return fresh;
    };

    const posts = await tx.query<{
      id: string;
      name: string;
      display_order: number;
      seats: number;
    }>("select id, name, display_order, seats from public.posts where election_id = $1", [
      source.id,
    ]);
    for (const p of posts.rows) {
      await tx.query(
        `insert into public.posts (id, election_id, name, display_order, seats)
         values ($1, $2, $3, $4, $5)`,
        [newIdFor(p.id), newId, p.name, p.display_order, p.seats],
      );
    }
    const candidates = await tx.query<{
      id: string;
      post_id: string;
      name: string;
      sort_order: number;
      photo_hash: string | null;
      symbol_hash: string | null;
      symbol_text: string | null;
    }>(
      `select id, post_id, name, sort_order, photo_hash, symbol_hash, symbol_text
         from public.candidates where election_id = $1`,
      [source.id],
    );
    for (const c of candidates.rows) {
      await tx.query(
        `insert into public.candidates
           (id, election_id, post_id, name, sort_order, photo_hash, symbol_hash, symbol_text)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          newIdFor(c.id),
          newId,
          newIdFor(c.post_id),
          c.name,
          c.sort_order,
          c.photo_hash,
          c.symbol_hash,
          c.symbol_text,
        ],
      );
    }
    const booths = await tx.query<{ id: string; name: string; location: string }>(
      "select id, name, location from public.booths where election_id = $1",
      [source.id],
    );
    for (const b of booths.rows) {
      await tx.query(
        "insert into public.booths (id, election_id, name, location) values ($1, $2, $3, $4)",
        [newIdFor(b.id), newId, b.name, b.location],
      );
    }
    const mappings = await tx.query<{ booth_id: string; post_id: string }>(
      "select booth_id, post_id from public.booth_posts where election_id = $1",
      [source.id],
    );
    for (const m of mappings.rows) {
      await tx.query(
        "insert into public.booth_posts (election_id, booth_id, post_id) values ($1, $2, $3)",
        [newId, newIdFor(m.booth_id), newIdFor(m.post_id)],
      );
    }

    return {
      result: { electionId: newId },
      audit: {
        electionId: newId,
        target: { type: "election", id: newId },
        before: null,
        after: { name: input.name, status: "draft", cloned_from: source.id },
        detail: {
          posts: posts.rows.length,
          candidates: candidates.rows.length,
          booths: booths.rows.length,
          mappings: mappings.rows.length,
        },
      },
    };
  },
});
