import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "@/lib/audit/canonical-json";

/**
 * Pure freeze logic: validation, uncontested detection, ballot serials, per-booth Ballot
 * Definitions and the Setup Hash. No database access, so every rule is unit-testable.
 * The published format is documented in docs/SETUP_FORMAT.md.
 */

export interface SetupCandidate {
  id: string;
  name: string;
  sortOrder: number;
  photoHash: string | null;
  symbolHash: string | null;
  symbolText: string | null;
}

export interface SetupPost {
  id: string;
  name: string;
  seats: number;
  displayOrder: number;
  candidates: SetupCandidate[];
}

export interface SetupBooth {
  id: string;
  name: string;
  location: string;
  /** Posts mapped to this booth (Booth-Post mapping). */
  postIds: string[];
  /** Active Presiding Officer assignments for this booth. */
  presidingOfficers: number;
}

export interface SetupData {
  election: {
    id: string;
    name: string;
    description: string;
    /** YYYY-MM-DD */
    pollingDate: string;
    notaEnabled: boolean;
  };
  posts: SetupPost[];
  booths: SetupBooth[];
}

export type ViolationCode =
  | "no_posts"
  | "too_few_candidates"
  | "post_unmapped"
  | "booth_without_post"
  | "booth_without_presiding_officer";

export interface Violation {
  code: ViolationCode;
  message: string;
  subject: { type: "election" | "post" | "booth"; id: string; name: string };
}

export const isUncontested = (post: SetupPost): boolean => post.candidates.length === post.seats;

const byOrder = (a: SetupPost, b: SetupPost) =>
  a.displayOrder - b.displayOrder || a.id.localeCompare(b.id);

/** Every freeze rule is checked; all violations are reported together. */
export function validateFreeze(data: SetupData): Violation[] {
  const violations: Violation[] = [];
  const election = { type: "election", id: data.election.id, name: data.election.name } as const;

  if (data.posts.length === 0) {
    violations.push({
      code: "no_posts",
      message: "The Election has no Posts",
      subject: election,
    });
  }

  const contested = new Set<string>();
  for (const post of [...data.posts].sort(byOrder)) {
    const subject = { type: "post", id: post.id, name: post.name } as const;
    if (post.candidates.length < post.seats) {
      violations.push({
        code: "too_few_candidates",
        message: `Post "${post.name}" has ${post.seats} seat(s) but only ${post.candidates.length} Candidate(s)`,
        subject,
      });
    } else if (!isUncontested(post)) {
      contested.add(post.id);
    }
  }

  const mapped = new Set(data.booths.flatMap((b) => b.postIds));
  for (const post of [...data.posts].sort(byOrder)) {
    if (contested.has(post.id) && !mapped.has(post.id)) {
      violations.push({
        code: "post_unmapped",
        message: `Post "${post.name}" is not mapped to any Polling Booth`,
        subject: { type: "post", id: post.id, name: post.name },
      });
    }
  }

  for (const booth of [...data.booths].sort(byBooth)) {
    const subject = { type: "booth", id: booth.id, name: booth.name } as const;
    if (!booth.postIds.some((id) => contested.has(id))) {
      violations.push({
        code: "booth_without_post",
        message: `Booth "${booth.name}" is not mapped to any contested Post`,
        subject,
      });
    }
    if (booth.presidingOfficers !== 1) {
      violations.push({
        code: "booth_without_presiding_officer",
        message: `Booth "${booth.name}" has no Presiding Officer`,
        subject,
      });
    }
  }
  return violations;
}

const byBooth = (a: SetupBooth, b: SetupBooth) =>
  a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);

export interface FrozenBoothDefinition {
  boothId: string;
  canonicalJson: string;
  hash: string;
}

export interface FrozenSetup {
  uncontestedPostIds: string[];
  canonicalJson: string;
  setupHash: string;
  definitions: FrozenBoothDefinition[];
}

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Builds the canonical frozen setup, its Setup Hash and one Ballot Definition per booth.
 * `freezeNumber` is the generation (1 for the first freeze, 2 after an unfreeze, ...), which
 * makes a later freeze hash differently even if nothing else changed.
 * Callers must have validated the data (`validateFreeze` returned no violations).
 */
export function buildFrozenSetup(data: SetupData, freezeNumber: number): FrozenSetup {
  const posts = [...data.posts].sort(byOrder);
  const orderOf = new Map(posts.map((p, i) => [p.id, i]));
  const serials = new Map<string, number>(); // candidate id -> ballot serial (contested only)
  const uncontestedPostIds: string[] = [];

  const postEntries = posts.map((post) => {
    const candidates = [...post.candidates].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
    );
    const uncontested = isUncontested(post);
    if (uncontested) uncontestedPostIds.push(post.id);
    else candidates.forEach((c, i) => serials.set(c.id, i + 1));
    return {
      id: post.id,
      name: post.name,
      seats: post.seats,
      display_order: post.displayOrder,
      uncontested,
      candidates: candidates.map((c) => candidateEntry(c, serials.get(c.id) ?? null)),
    };
  });

  const booths = [...data.booths].sort(byBooth);
  const setup: JsonValue = {
    version: 1,
    freeze_number: freezeNumber,
    election: {
      id: data.election.id,
      name: data.election.name,
      description: data.election.description,
      polling_date: data.election.pollingDate,
      nota_enabled: data.election.notaEnabled,
    },
    posts: postEntries,
    booths: booths.map((b) => ({
      id: b.id,
      name: b.name,
      location: b.location,
      post_ids: [...b.postIds].sort((x, y) => (orderOf.get(x) ?? 0) - (orderOf.get(y) ?? 0)),
    })),
  };
  const canonical = canonicalJson(setup);
  const setupHash = sha256Hex(canonical);

  const definitions = booths.map((booth): FrozenBoothDefinition => {
    const mapped = new Set(booth.postIds);
    const definition: JsonValue = {
      version: 1,
      election_id: data.election.id,
      booth_id: booth.id,
      freeze_number: freezeNumber,
      setup_hash: setupHash,
      nota_enabled: data.election.notaEnabled,
      posts: postEntries
        .filter((p) => mapped.has(p.id) && !p.uncontested)
        .map((p) => ({
          post_id: p.id,
          name: p.name,
          seats: p.seats,
          candidates: p.candidates,
          // NOTA always follows the last Candidate.
          nota_serial: data.election.notaEnabled ? p.candidates.length + 1 : null,
        })),
    };
    const json = canonicalJson(definition);
    return { boothId: booth.id, canonicalJson: json, hash: sha256Hex(json) };
  });

  return { uncontestedPostIds, canonicalJson: canonical, setupHash, definitions };
}

function candidateEntry(c: SetupCandidate, serial: number | null): JsonValue {
  return {
    id: c.id,
    serial,
    name: c.name,
    photo_hash: c.photoHash,
    symbol_hash: c.symbolHash,
    symbol_text: c.symbolText,
  };
}
