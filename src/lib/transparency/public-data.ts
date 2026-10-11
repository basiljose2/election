import type { Pool } from "pg";

/**
 * Everything the public pages show is read from the explicit public_* views, and from
 * nothing else: a Draft Election does not exist for them, and no table with votes, staff or
 * sessions can be reached from here.
 */

type Queryable = Pick<Pool, "query">;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicElectionSummary {
  id: string;
  name: string;
  pollingDate: string;
  status: string;
}

export async function listPublicElections(db: Queryable): Promise<PublicElectionSummary[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    polling_date: Date | string;
    status: string;
  }>(
    "select id, name, polling_date, status from public.public_elections order by polling_date desc, name",
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    pollingDate:
      r.polling_date instanceof Date
        ? r.polling_date.toISOString().slice(0, 10)
        : String(r.polling_date).slice(0, 10),
    status: r.status,
  }));
}

export interface PublicSetup {
  election: { id: string; name: string; description: string; notaEnabled: boolean; status: string };
  setupHash: string;
  freezeNo: number;
  publicKey: string | null;
  posts: Array<{
    id: string;
    name: string;
    seats: number;
    uncontested: boolean;
    candidates: Array<{
      id: string;
      serial: number | null;
      name: string;
      photoHash: string | null;
      symbolHash: string | null;
      symbolText: string | null;
    }>;
  }>;
  booths: Array<{
    id: string;
    name: string;
    location: string;
    definitionHash: string;
    postIds: string[];
  }>;
}

interface SetupJson {
  posts: Array<{
    id: string;
    name: string;
    seats: number;
    uncontested: boolean;
    candidates: Array<{
      id: string;
      serial: number | null;
      name: string;
      photo_hash: string | null;
      symbol_hash: string | null;
      symbol_text: string | null;
    }>;
  }>;
  booths: Array<{ id: string; name: string; location: string; post_ids: string[] }>;
}

/** The frozen setup of a non-Draft Election, or null (as if it did not exist). */
export async function getPublicSetup(
  db: Queryable,
  electionId: string,
): Promise<PublicSetup | null> {
  if (!UUID.test(electionId)) return null;
  const election = await db.query<{
    id: string;
    name: string;
    description: string;
    nota_enabled: boolean;
    status: string;
  }>(
    "select id, name, description, nota_enabled, status from public.public_elections where id = $1",
    [electionId],
  );
  const e = election.rows[0];
  if (!e) return null;
  const setup = await db.query<{ freeze_no: number; setup_hash: string; canonical_json: string }>(
    "select freeze_no, setup_hash, canonical_json from public.public_setups where election_id = $1",
    [electionId],
  );
  const s = setup.rows[0];
  if (!s) return null;
  const key = await db.query<{ public_key: string }>(
    "select public_key from public.public_signing_keys where election_id = $1",
    [electionId],
  );
  const definitions = await db.query<{ booth_id: string; definition_hash: string }>(
    "select booth_id, definition_hash from public.public_ballot_definitions where election_id = $1",
    [electionId],
  );
  const hashOf = new Map(definitions.rows.map((d) => [d.booth_id, d.definition_hash]));
  const json = JSON.parse(s.canonical_json) as SetupJson;
  return {
    election: {
      id: e.id,
      name: e.name,
      description: e.description,
      notaEnabled: e.nota_enabled,
      status: e.status,
    },
    setupHash: s.setup_hash,
    freezeNo: s.freeze_no,
    publicKey: key.rows[0]?.public_key ?? null,
    posts: json.posts.map((p) => ({
      id: p.id,
      name: p.name,
      seats: p.seats,
      uncontested: p.uncontested,
      candidates: p.candidates.map((c) => ({
        id: c.id,
        serial: c.serial,
        name: c.name,
        photoHash: c.photo_hash,
        symbolHash: c.symbol_hash,
        symbolText: c.symbol_text,
      })),
    })),
    booths: json.booths.map((b) => ({
      id: b.id,
      name: b.name,
      location: b.location,
      definitionHash: hashOf.get(b.id) ?? "",
      postIds: b.post_ids,
    })),
  };
}

export interface PublicBoothStatus {
  boothId: string;
  name: string;
  location: string;
  state: string;
  ballotsCast: number;
  ballotsCancelled: number;
}

export interface PublicStatus {
  electionId: string;
  electionName: string;
  electionStatus: string;
  generatedAt: string;
  booths: PublicBoothStatus[];
  totals: { ballotsCast: number; ballotsCancelled: number };
}

/** Booth states and turnout totals. No per-candidate data and no staff identities. */
export async function getPublicStatus(
  db: Queryable,
  electionId: string,
  now: Date = new Date(),
): Promise<PublicStatus | null> {
  if (!UUID.test(electionId)) return null;
  const election = await db.query<{ name: string; status: string }>(
    "select name, status from public.public_elections where id = $1",
    [electionId],
  );
  if (!election.rows[0]) return null;
  const { rows } = await db.query<{
    booth_id: string;
    name: string;
    location: string;
    state: string;
    ballots_cast: string;
    ballots_cancelled: string;
  }>(
    `select booth_id, name, location, state, ballots_cast, ballots_cancelled
       from public.public_booth_status where election_id = $1 order by name, booth_id`,
    [electionId],
  );
  const booths = rows.map((r) => ({
    boothId: r.booth_id,
    name: r.name,
    location: r.location,
    state: r.state,
    ballotsCast: Number(r.ballots_cast),
    ballotsCancelled: Number(r.ballots_cancelled),
  }));
  return {
    electionId,
    electionName: election.rows[0].name,
    electionStatus: election.rows[0].status,
    generatedAt: now.toISOString(),
    booths,
    totals: {
      ballotsCast: booths.reduce((s, b) => s + b.ballotsCast, 0),
      ballotsCancelled: booths.reduce((s, b) => s + b.ballotsCancelled, 0),
    },
  };
}

export interface PublicTally {
  boothId: string;
  boothName: string;
  status: "pass" | "failed";
  tallyHash: string;
  merkleRoot: string;
  signature: string;
  ballotsCast: number;
  ballotsCancelled: number;
  closedAt: string;
}

export async function getPublicTallies(db: Queryable, electionId: string): Promise<PublicTally[]> {
  if (!UUID.test(electionId)) return [];
  const { rows } = await db.query<{
    booth_id: string;
    name: string;
    status: "pass" | "failed";
    tally_hash: string;
    signature: string;
    canonical_json: string;
  }>(
    `select t.booth_id, b.name, t.status, t.tally_hash, t.signature, t.canonical_json
       from public.public_booth_tallies t
       join public.public_booth_status b on b.booth_id = t.booth_id
      where t.election_id = $1 order by b.name, t.booth_id`,
    [electionId],
  );
  return rows.map((r) => {
    const content = JSON.parse(r.canonical_json) as {
      merkle_root: string;
      ballots_cast: number;
      ballots_cancelled: number;
      closed_at: string;
    };
    return {
      boothId: r.booth_id,
      boothName: r.name,
      status: r.status,
      tallyHash: r.tally_hash,
      merkleRoot: content.merkle_root,
      signature: r.signature,
      ballotsCast: content.ballots_cast,
      ballotsCancelled: content.ballots_cancelled,
      closedAt: content.closed_at,
    };
  });
}

/** The declared Result, or null before declaration (no per-candidate data exists before). */
export async function getPublicResult(
  db: Queryable,
  electionId: string,
): Promise<{ resultHash: string; signature: string; canonicalJson: string } | null> {
  if (!UUID.test(electionId)) return null;
  const { rows } = await db.query<{
    result_hash: string;
    signature: string;
    canonical_json: string;
  }>(
    "select result_hash, signature, canonical_json from public.public_results where election_id = $1",
    [electionId],
  );
  const r = rows[0];
  return r
    ? { resultHash: r.result_hash, signature: r.signature, canonicalJson: r.canonical_json }
    : null;
}
