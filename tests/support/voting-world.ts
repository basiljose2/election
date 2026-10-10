import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { appendAuditEvent } from "@/lib/audit/append";
import type { Actor } from "@/lib/auth/roles";
import { freezeSetup } from "@/lib/commands/freeze";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { hashCredential, type AuthenticatedTerminal } from "@/lib/terminals/credentials";
import { actorFor, createStaffFixture, setBoothState, type BoothStateName } from "./fixtures";

/**
 * A complete, really-frozen Election for casting tests:
 *   President (1 seat, 3 candidates) and Council (2 seats, 3 candidates), NOTA optional,
 *   one booth mapped to both Posts, its Presiding Officer, a Master and a Voting Terminal.
 */
export interface VotingWorld {
  electionId: string;
  boothId: string;
  presidentId: string;
  councilId: string;
  presidents: string[];
  councillors: string[];
  po: Actor;
  ro: Actor;
  masterToken: string;
  masterTerminal: AuthenticatedTerminal;
  voting: AuthenticatedTerminal;
  publicKey: string;
  /** Set with `unmappedPost`: a contested Post of the Election that this booth is NOT mapped to. */
  unmapped: { postId: string; candidateId: string } | null;
  /** Set with `unmappedPost`: the second booth (it carries the unmapped Post) and its officer. */
  other: { boothId: string; po: Actor } | null;
}

export async function buildVotingWorld(
  admin: Pool,
  options: {
    nota?: boolean;
    booth?: BoothStateName;
    election?: "frozen" | "polling_open";
    online?: boolean;
    now?: Date;
    /** Adds a contested Post (two Candidates) that is not mapped to the booth. */
    unmappedPost?: boolean;
  } = {},
): Promise<VotingWorld> {
  const { nota = true, booth = "open", election = "polling_open", online = true } = options;
  const now = options.now ?? new Date();
  const electionId = randomUUID();
  const boothId = randomUUID();
  const presidentId = randomUUID();
  const councilId = randomUUID();
  const presidents = [randomUUID(), randomUUID(), randomUUID()];
  const councillors = [randomUUID(), randomUUID(), randomUUID()];

  await admin.query(
    "insert into public.elections (id, name, polling_date, nota_enabled) values ($1, $2, current_date, $3)",
    [electionId, `Casting ${electionId}`, nota],
  );
  await admin.query(
    "insert into public.posts (id, election_id, name, display_order, seats) values ($1, $3, 'President', 0, 1), ($2, $3, 'Council', 1, 2)",
    [presidentId, councilId, electionId],
  );
  for (const [i, id] of presidents.entries()) {
    await admin.query(
      "insert into public.candidates (id, election_id, post_id, name, sort_order) values ($1, $2, $3, $4, $5)",
      [id, electionId, presidentId, `President ${i}`, i],
    );
  }
  for (const [i, id] of councillors.entries()) {
    await admin.query(
      "insert into public.candidates (id, election_id, post_id, name, sort_order) values ($1, $2, $3, $4, $5)",
      [id, electionId, councilId, `Councillor ${i}`, i],
    );
  }
  await admin.query(
    "insert into public.booths (id, election_id, name, location) values ($1, $2, 'Main Hall', 'A')",
    [boothId, electionId],
  );
  let unmapped: VotingWorld["unmapped"] = null;
  let other: VotingWorld["other"] = null;
  if (options.unmappedPost) {
    unmapped = { postId: randomUUID(), candidateId: randomUUID() };
    await admin.query(
      "insert into public.posts (id, election_id, name, display_order, seats) values ($1, $2, 'Unmapped', 9, 1)",
      [unmapped.postId, electionId],
    );
    for (const [i, id] of [unmapped.candidateId, randomUUID()].entries()) {
      await admin.query(
        "insert into public.candidates (id, election_id, post_id, name, sort_order) values ($1, $2, $3, $4, $5)",
        [id, electionId, unmapped.postId, `Unmapped ${i}`, i],
      );
    }
  }
  for (const postId of [presidentId, councilId]) {
    await admin.query(
      "insert into public.booth_posts (election_id, booth_id, post_id) values ($1, $2, $3)",
      [electionId, boothId, postId],
    );
  }
  if (unmapped) {
    // Every Post must be mapped somewhere to freeze: another booth carries it.
    const otherBooth = randomUUID();
    await admin.query(
      "insert into public.booths (id, election_id, name, location) values ($1, $2, 'Other Hall', 'B')",
      [otherBooth, electionId],
    );
    await admin.query(
      "insert into public.booth_posts (election_id, booth_id, post_id) values ($1, $2, $3)",
      [electionId, otherBooth, unmapped.postId],
    );
    const otherPo = await createStaffFixture(admin, [
      { role: "presiding_officer", electionId, boothId: otherBooth },
    ]);
    other = { boothId: otherBooth, po: actorFor(otherPo) };
  }
  const po = actorFor(
    await createStaffFixture(admin, [{ role: "presiding_officer", electionId, boothId }]),
  );
  const ro = actorFor(await createStaffFixture(admin, [{ role: "returning_officer", electionId }]));

  // The real freeze: Ballot Definitions, Setup Hash and the Election's signing key.
  const deps: Partial<GatewayDeps> = {
    now: () => now,
    authenticate: async () => ro,
    appendAudit: appendAuditEvent,
  };
  await executeCommand(freezeSetup, { electionId }, { ...deps, db: admin });
  if (election === "polling_open") {
    await admin.query("update public.elections set status = 'polling_open' where id = $1", [
      electionId,
    ]);
  }

  const masterToken = randomBytes(32).toString("base64url");
  const master = await admin.query<{ id: string }>(
    `insert into public.terminals (election_id, booth_id, type, credential_hash)
     values ($1, $2, 'master', $3) returning id`,
    [electionId, boothId, hashCredential(masterToken)],
  );
  const votingRow = await admin.query<{ id: string }>(
    `insert into public.terminals (election_id, booth_id, type, credential_hash, device_id)
     values ($1, $2, 'voting', $3, 'AB12') returning id`,
    [electionId, boothId, hashCredential(randomBytes(32).toString("base64url"))],
  );
  if (online) {
    await admin.query(
      "insert into public.terminal_heartbeats (terminal_id, last_seen_at) values ($1, $2)",
      [votingRow.rows[0]!.id, now],
    );
  }

  await setBoothState(admin, boothId, booth);
  if (booth === "mock_poll") {
    await admin.query("update public.booth_counters set mock_round = 1 where booth_id = $1", [
      boothId,
    ]);
  }

  const key = await admin.query<{ public_key: string }>(
    "select public_key from public.election_signing_keys where election_id = $1",
    [electionId],
  );
  return {
    electionId,
    boothId,
    presidentId,
    councilId,
    presidents,
    councillors,
    po,
    ro,
    masterToken,
    masterTerminal: {
      id: master.rows[0]!.id,
      electionId,
      boothId,
      type: "master",
      deviceId: null,
    },
    voting: {
      id: votingRow.rows[0]!.id,
      electionId,
      boothId,
      type: "voting",
      deviceId: "AB12",
    },
    publicKey: key.rows[0]!.public_key,
    unmapped,
    other,
  };
}

/** A valid ballot for the world's booth: one President and two Councillors (or NOTA). */
export function validAnswers(
  w: VotingWorld,
  pick: { president?: number | "nota"; council?: [number, number] | "nota" } = {},
) {
  const president = pick.president ?? 0;
  const council = pick.council ?? [0, 1];
  return [
    president === "nota"
      ? { postId: w.presidentId, nota: true }
      : { postId: w.presidentId, candidateIds: [w.presidents[president]!] },
    council === "nota"
      ? { postId: w.councilId, nota: true }
      : { postId: w.councilId, candidateIds: council.map((i) => w.councillors[i]!) },
  ];
}
