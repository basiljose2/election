import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import { buildAuditExport } from "@/lib/audit/export";
import { loadResult } from "@/lib/results/declare";

type Queryable = Pick<Pool | PoolClient, "query">;

export const BUNDLE_FORMAT = "campus-evm-verification-bundle/v1";

export interface BundleFile {
  path: string;
  data: Buffer;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

const README = `# Campus EVM verification bundle

This archive holds everything needed to check an election WITHOUT trusting the server that
ran it. Open the verifier page (/verify) or run \`node tools/verifier/verify-bundle.mjs
<this-file.zip>\`; both work offline. Every algorithm below is short enough to re-implement.

## Files

- manifest.json: format, election id and the SHA-256 of every other file
- setup.json: the frozen setup (canonical JSON string), its freeze number and Setup Hash
- public-key.json: the election's Ed25519 public key (raw 32 bytes, base64url)
- ballot-definitions.json: each booth's Ballot Definition (canonical JSON) and its hash
- audit.json: the election's full audit chain (campus-evm-audit-export/v1)
- tallies.json: every Booth Tally (canonical JSON), its hash and signature
- selections/<booth-id>.json: every real Vote Selection of the booth, sorted by id
- result.json: the declared Result (canonical JSON), its hash and signature

A Vote Selection row is { id, post_id, candidate_id | null, is_nota, signature }. It carries
no session, terminal, time or order information: the id is random and the rows are sorted by
it only so the file is reproducible.

## Algorithms

- Canonical JSON: keys sorted by UTF-16 code units, no insignificant whitespace, integers
  only, strings as JSON.stringify writes them, UTF-8.
- Setup Hash = hex(SHA-256(setup.canonical_json)). It must equal after.setup_hash of the
  election.frozen audit event, and every Ballot Definition's setup_hash.
- Audit chain: genesis = hex(SHA-256("campus-evm/audit-genesis/v1:" + election_id));
  hash(e) = hex(SHA-256(e.prev_hash + canonical_json({election_id, seq, prev_hash, payload}))).
- Vote Selection signature: Ed25519 over the UTF-8 bytes of canonical_json({ booth_id,
  candidate_id, election_id, id, is_mock: false, is_nota, mock_round: null, post_id }),
  signature base64url.
- Merkle root of a booth: leaves sorted by selection id; leaf = SHA-256(0x00 || canonical
  selection JSON || signature as UTF-8); parent = SHA-256(0x01 || left || right); an odd last
  node is promoted unchanged; an empty tree is SHA-256 of the empty string. It must equal
  merkle_root in the booth's Booth Tally, with the same row count.
- Booth Tally hash = hex(SHA-256(canonical_json)); signed with the election key, and its
  hash appears in the audit chain.
- Ballot-answer rule: for each Post of the booth, candidate rows are divisible by the seats,
  and candidate rows / seats + NOTA rows equals the tally's ballots_cast.
- Result: hash and signature as for a tally; its hash appears in the audit chain.
- Recount: sum the rows of all booths per Post and Candidate; they must equal the Result.
- Winner rules: rank Candidates by votes (NOTA excluded). Let V be the votes of the N-th. If
  nobody below rank N has V votes, the top N are Elected. Otherwise Candidates above V are
  Elected and every Candidate on exactly V is tied for the remaining seats. Ties are never
  broken. NOTA is flagged when its votes exceed those of any Elected Candidate.
`;

export interface BundleInput {
  electionId: string;
  setup: { setupHash: string; freezeNo: number; canonicalJson: string };
  publicKey: string;
  definitions: Array<{ boothId: string; definitionHash: string; canonicalJson: string }>;
  audit: unknown;
  tallies: Array<{
    boothId: string;
    status: string;
    tallyHash: string;
    signature: string;
    canonicalJson: string;
  }>;
  selections: Map<
    string,
    Array<{
      id: string;
      post_id: string;
      candidate_id: string | null;
      is_nota: boolean;
      signature: string;
    }>
  >;
  result: { resultHash: string; signature: string; canonicalJson: string };
}

/** The bundle's files, in a fixed order, with a manifest of their hashes. */
export function bundleFiles(input: BundleInput): BundleFile[] {
  const files: BundleFile[] = [
    { path: "README.md", data: Buffer.from(README, "utf8") },
    {
      path: "setup.json",
      data: json({
        setup_hash: input.setup.setupHash,
        freeze_no: input.setup.freezeNo,
        canonical_json: input.setup.canonicalJson,
      }),
    },
    {
      path: "public-key.json",
      data: json({ algorithm: "Ed25519", public_key: input.publicKey }),
    },
    {
      path: "ballot-definitions.json",
      data: json(
        [...input.definitions]
          .sort((a, b) => a.boothId.localeCompare(b.boothId))
          .map((d) => ({
            booth_id: d.boothId,
            definition_hash: d.definitionHash,
            canonical_json: d.canonicalJson,
          })),
      ),
    },
    { path: "audit.json", data: json(input.audit) },
    {
      path: "tallies.json",
      data: json(
        [...input.tallies]
          .sort((a, b) => a.boothId.localeCompare(b.boothId))
          .map((t) => ({
            booth_id: t.boothId,
            status: t.status,
            tally_hash: t.tallyHash,
            signature: t.signature,
            canonical_json: t.canonicalJson,
          })),
      ),
    },
  ];
  for (const boothId of [...input.selections.keys()].sort()) {
    const rows = [...input.selections.get(boothId)!].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    files.push({ path: `selections/${boothId}.json`, data: json(rows) });
  }
  files.push({
    path: "result.json",
    data: json({
      result_hash: input.result.resultHash,
      signature: input.result.signature,
      canonical_json: input.result.canonicalJson,
    }),
  });

  const manifest = {
    format: BUNDLE_FORMAT,
    election_id: input.electionId,
    result_hash: input.result.resultHash,
    files: Object.fromEntries(files.map((f) => [f.path, sha256(f.data)])),
  };
  return [{ path: "manifest.json", data: json(manifest) }, ...files];
}

/** A deterministic zip (fixed timestamps, deflate) of the files. */
export function zipFiles(files: BundleFile[]): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const compressed = deflateRawSync(file.data, { level: 9 });
    const crc = crc32(file.data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + compressed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Reads everything the bundle needs for a declared Election. */
export async function loadBundleInput(db: Queryable, electionId: string): Promise<BundleInput> {
  const result = await loadResult(db, electionId);
  if (!result) throw new Error("results have not been declared");

  const setup = await db.query<{ freeze_no: number; setup_hash: string; canonical_json: string }>(
    `select freeze_no, setup_hash, canonical_json from public.public_setups where election_id = $1`,
    [electionId],
  );
  const key = await db.query<{ public_key: string }>(
    "select public_key from public.public_signing_keys where election_id = $1",
    [electionId],
  );
  const definitions = await db.query<{
    booth_id: string;
    definition_hash: string;
    canonical_json: string;
  }>(
    `select booth_id, definition_hash, canonical_json from public.public_ballot_definitions
      where election_id = $1`,
    [electionId],
  );
  const tallies = await db.query<{
    booth_id: string;
    status: string;
    tally_hash: string;
    signature: string;
    canonical_json: string;
  }>(
    `select booth_id, status, tally_hash, signature, canonical_json
       from public.public_booth_tallies where election_id = $1`,
    [electionId],
  );
  const rows = await db.query<{
    booth_id: string;
    id: string;
    post_id: string;
    candidate_id: string | null;
    is_nota: boolean;
    signature: string;
  }>("select * from public.export_booth_selections($1)", [electionId]);

  const selections = new Map<
    string,
    BundleInput["selections"] extends Map<string, infer V> ? V : never
  >();
  for (const booth of definitions.rows) selections.set(booth.booth_id, []);
  for (const r of rows.rows) {
    const list = selections.get(r.booth_id) ?? [];
    list.push({
      id: r.id,
      post_id: r.post_id,
      candidate_id: r.candidate_id,
      is_nota: r.is_nota,
      signature: r.signature,
    });
    selections.set(r.booth_id, list);
  }

  return {
    electionId,
    setup: {
      setupHash: setup.rows[0]!.setup_hash,
      freezeNo: setup.rows[0]!.freeze_no,
      canonicalJson: setup.rows[0]!.canonical_json,
    },
    publicKey: key.rows[0]!.public_key,
    definitions: definitions.rows.map((d) => ({
      boothId: d.booth_id,
      definitionHash: d.definition_hash,
      canonicalJson: d.canonical_json,
    })),
    audit: await buildAuditExport(db, electionId),
    tallies: tallies.rows.map((t) => ({
      boothId: t.booth_id,
      status: t.status,
      tallyHash: t.tally_hash,
      signature: t.signature,
      canonicalJson: t.canonical_json,
    })),
    selections,
    result: {
      resultHash: result.resultHash,
      signature: result.signature,
      canonicalJson: result.canonicalJson,
    },
  };
}

export interface StoredBundle {
  zip: Buffer;
  bundleHash: string;
}

/**
 * The stored bundle for a declared Election, created on first use. It is generated right
 * after the declaration commits (so the chain it carries includes the declaration event) and
 * built again on demand if that step did not complete; the result is the same bytes.
 */
export async function ensureBundle(db: Pool, electionId: string): Promise<StoredBundle | null> {
  const existing = await db.query<{ zip: Buffer; bundle_hash: string }>(
    "select zip, bundle_hash from public.verification_bundles where election_id = $1",
    [electionId],
  );
  if (existing.rows[0]) {
    return { zip: existing.rows[0].zip, bundleHash: existing.rows[0].bundle_hash };
  }
  const declared = await loadResult(db, electionId);
  if (!declared) return null;

  const zip = zipFiles(bundleFiles(await loadBundleInput(db, electionId)));
  const bundleHash = sha256(zip);
  await db.query(
    `insert into public.verification_bundles (election_id, zip, bundle_hash)
     values ($1, $2, $3) on conflict (election_id) do nothing`,
    [electionId, zip, bundleHash],
  );
  const stored = await db.query<{ zip: Buffer; bundle_hash: string }>(
    "select zip, bundle_hash from public.verification_bundles where election_id = $1",
    [electionId],
  );
  return { zip: stored.rows[0]!.zip, bundleHash: stored.rows[0]!.bundle_hash };
}
