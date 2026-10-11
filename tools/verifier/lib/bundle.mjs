// Independent verifier for Campus EVM verification bundles (campus-evm-verification-bundle/v1).
//
// Deliberately self-contained and isomorphic: it uses only the Web Crypto API and standard
// JavaScript, imports nothing from the application, and never touches the network, so the
// same file runs in the browser verifier page and in the Node CLI. Every algorithm is written
// out in the bundle's README so a third party can re-implement it.
//
//   const report = await verifyBundle(files)   // files: Map<path, Uint8Array>
//
// The checks, in order: manifest, setup, audit chain, Booth Tallies, Vote Selection
// signatures, Merkle roots, the ballot-answer rule, the Result, a full recount and the winner
// rules. Each check reports pass, fail (with the first failure) or skip.

export const BUNDLE_FORMAT = "campus-evm-verification-bundle/v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const subtle = globalThis.crypto.subtle;

// ------------------------------------------------------------------------------ primitives

export function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError(`non-integer number ${value}`);
      return Object.is(value, -0) ? "0" : String(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      return `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
        .join(",")}}`;
    default:
      throw new TypeError(`unsupported JSON type ${typeof value}`);
  }
}

const hex = (bytes) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(input) {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  return hex(await subtle.digest("SHA-256", bytes));
}

async function sha256Bytes(bytes) {
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}

function fromBase64Url(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function importKey(publicKey) {
  return subtle.importKey("raw", fromBase64Url(publicKey), { name: "Ed25519" }, false, ["verify"]);
}

async function verifySignature(key, text, signature) {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    return await subtle.verify(
      { name: "Ed25519" },
      key,
      fromBase64Url(signature),
      encoder.encode(text),
    );
  } catch {
    return false;
  }
}

/** Merkle root: leaf = SHA-256(0x00 || canonical || signature), parent = SHA-256(0x01 || l || r). */
export async function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256Hex(new Uint8Array(0));
  let level = leaves;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(
        level[i + 1]
          ? await sha256Bytes(concat(Uint8Array.of(1), level[i], level[i + 1]))
          : level[i],
      );
    }
    level = next;
  }
  return hex(level[0]);
}

export const selectionCanonical = (s, electionId, boothId) =>
  canonicalJson({
    id: s.id,
    election_id: electionId,
    booth_id: boothId,
    post_id: s.post_id,
    candidate_id: s.candidate_id,
    is_nota: s.is_nota,
    is_mock: false,
    mock_round: null,
  });

// ----------------------------------------------------------------------- winner rules

/**
 * The winner rules, written independently of the server: rank by votes (NOTA excluded); if
 * nobody below rank N shares the N-th vote count the top N are Elected, otherwise those above
 * it are Elected and everyone on it is tied for the remaining seats.
 */
export function winnerRules(seats, candidates, nota, notaEnabled) {
  const ranked = [...candidates].sort((a, b) => b.votes - a.votes || a.id.localeCompare(b.id));
  const outcome = {};
  let status = "elected";
  let tiedSeats = 0;
  if (ranked.length <= seats) {
    for (const c of ranked) outcome[c.id] = "elected";
  } else {
    const cutoff = ranked[seats - 1].votes;
    if (ranked[seats].votes < cutoff) {
      ranked.forEach((c, i) => (outcome[c.id] = i < seats ? "elected" : "not_elected"));
    } else {
      status = "tie";
      for (const c of ranked) {
        outcome[c.id] = c.votes > cutoff ? "elected" : c.votes === cutoff ? "tied" : "not_elected";
      }
      tiedSeats = seats - ranked.filter((c) => c.votes > cutoff).length;
    }
  }
  const elected = ranked.filter((c) => outcome[c.id] === "elected");
  const next = ranked.find((c) => outcome[c.id] !== "elected");
  return {
    status,
    outcome,
    tiedSeats,
    electedCount: elected.length,
    notaExceededWinner: notaEnabled && elected.some((c) => nota > c.votes),
    margin: elected.length > 0 && next ? elected[elected.length - 1].votes - next.votes : null,
  };
}

// ----------------------------------------------------------------------------- the checks

const json = (files, path) => {
  const bytes = files.get(path);
  if (!bytes) throw new Error(`the bundle has no ${path}`);
  return JSON.parse(decoder.decode(bytes));
};

function findKeyValues(value, key, found = []) {
  if (Array.isArray(value)) value.forEach((v) => findKeyValues(v, key, found));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === key && typeof v === "string") found.push(v);
      else findKeyValues(v, key, found);
    }
  }
  return found;
}

const pass = (id, title, detail = "") => ({ id, title, status: "pass", detail });
const fail = (id, title, detail) => ({ id, title, status: "fail", detail });
const skip = (id, title, detail) => ({ id, title, status: "skip", detail });

/**
 * @param {Map<string, Uint8Array>} files
 * @param {{ onProgress?: (message: string) => void }} [options]
 */
export async function verifyBundle(files, options = {}) {
  const progress = options.onProgress ?? (() => {});
  const checks = [];
  const notes = [];

  const manifest = json(files, "manifest.json");
  if (manifest.format !== BUNDLE_FORMAT)
    throw new Error(`unknown bundle format ${manifest.format}`);
  const electionId = manifest.election_id;
  const setup = json(files, "setup.json");
  const key = json(files, "public-key.json");
  const definitions = json(files, "ballot-definitions.json");
  const audit = json(files, "audit.json");
  const tallies = json(files, "tallies.json");
  const result = json(files, "result.json");
  const publicKey = await importKey(key.public_key);

  // 1. Every file is the one the manifest names.
  {
    const bad = [];
    for (const [path, expected] of Object.entries(manifest.files)) {
      const bytes = files.get(path);
      if (!bytes || (await sha256Hex(bytes)) !== expected) bad.push(path);
    }
    checks.push(
      bad.length === 0
        ? pass(
            "manifest",
            "Every file matches the manifest",
            `${Object.keys(manifest.files).length} files`,
          )
        : fail("manifest", "Every file matches the manifest", `changed or missing: ${bad[0]}`),
    );
  }

  // 2. Audit chain.
  progress("Checking the audit chain");
  const auditResult = await (async () => {
    let prev = await sha256Hex(`campus-evm/audit-genesis/v1:${audit.election_id ?? "system"}`);
    if (audit.genesis !== prev) return { ok: false, reason: "genesis value is wrong", seq: 1 };
    for (let i = 0; i < audit.events.length; i++) {
      const e = audit.events[i];
      if (e.seq !== i + 1)
        return { ok: false, reason: "event missing or out of order", seq: i + 1 };
      if (e.prev_hash !== prev)
        return { ok: false, reason: "link to the previous event is broken", seq: e.seq };
      const body = canonicalJson({
        election_id: e.election_id,
        seq: e.seq,
        prev_hash: e.prev_hash,
        payload: e.payload,
      });
      if ((await sha256Hex(e.prev_hash + body)) !== e.hash) {
        return { ok: false, reason: "event content does not match its hash", seq: e.seq };
      }
      prev = e.hash;
    }
    return { ok: true, count: audit.events.length };
  })();
  checks.push(
    auditResult.ok
      ? pass("audit_chain", "Audit chain is intact", `${auditResult.count} events`)
      : fail(
          "audit_chain",
          "Audit chain is intact",
          `event ${auditResult.seq}: ${auditResult.reason}`,
        ),
  );

  // 3. Setup Hash and Ballot Definitions, anchored in the audit event written at freeze.
  {
    const title = "Setup Hash and Ballot Definitions are unchanged";
    const frozen = [...audit.events]
      .reverse()
      .find((e) => e.payload?.event_type === "election.frozen");
    const problems = [];
    if ((await sha256Hex(setup.canonical_json)) !== setup.setup_hash) problems.push("setup hash");
    if (!frozen) problems.push("no election.frozen event in the chain");
    else {
      if (frozen.payload.after?.setup_hash !== setup.setup_hash)
        problems.push("setup hash vs audit");
      const anchored = new Map(
        (frozen.payload.detail?.booth_definitions ?? []).map((d) => [
          d.booth_id,
          d.definition_hash,
        ]),
      );
      for (const d of definitions) {
        if ((await sha256Hex(d.canonical_json)) !== d.definition_hash)
          problems.push(`definition ${d.booth_id}`);
        if (anchored.get(d.booth_id) !== d.definition_hash)
          problems.push(`definition anchor ${d.booth_id}`);
        if (JSON.parse(d.canonical_json).setup_hash !== setup.setup_hash)
          problems.push("definition setup hash");
      }
    }
    checks.push(
      problems.length === 0
        ? pass("setup", title, setup.setup_hash)
        : fail("setup", title, problems[0]),
    );
  }

  // 4. Booth Tallies: hash, signature, and anchored in the audit chain.
  progress("Checking Booth Tallies");
  const anchoredTallies = new Set(findKeyValues(audit.events, "tally_hash"));
  const tallyOf = new Map();
  {
    const title = "Booth Tallies are signed and anchored in the audit chain";
    const problems = [];
    for (const t of tallies) {
      tallyOf.set(t.booth_id, { ...t, content: JSON.parse(t.canonical_json) });
      if ((await sha256Hex(t.canonical_json)) !== t.tally_hash)
        problems.push(`tally hash ${t.booth_id}`);
      else if (!(await verifySignature(publicKey, t.canonical_json, t.signature))) {
        problems.push(`tally signature ${t.booth_id}`);
      } else if (!anchoredTallies.has(t.tally_hash))
        problems.push(`tally not in audit ${t.booth_id}`);
    }
    checks.push(
      problems.length === 0
        ? pass("tallies", title, `${tallies.length} booths`)
        : fail("tallies", title, problems[0]),
    );
  }

  // 5-7. Vote Selections per booth: signatures, Merkle root and count, ballot-answer rule.
  const postsOfBooth = new Map(
    definitions.map((d) => [d.booth_id, JSON.parse(d.canonical_json).posts]),
  );
  const sigProblems = [];
  const merkleProblems = [];
  const answerProblems = [];
  const counts = new Map(); // post -> { candidates: {id: n}, nota: n }
  const withheldPosts = new Set(
    JSON.parse(result.canonical_json)
      .posts.filter((p) => p.status === "withheld")
      .map((p) => p.postId),
  );
  let totalSelections = 0;

  for (const [path, bytes] of files) {
    const m = /^selections\/([0-9a-f-]{36})\.json$/.exec(path);
    if (!m) continue;
    const boothId = m[1];
    const rows = JSON.parse(decoder.decode(bytes));
    totalSelections += rows.length;
    progress(`Checking ${rows.length} Vote Selections of booth ${boothId.slice(0, 8)}`);

    const leaves = [];
    let badSignature = null;
    const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const row of sorted) {
      const canonical = selectionCanonical(row, electionId, boothId);
      if (badSignature === null && !(await verifySignature(publicKey, canonical, row.signature))) {
        badSignature = row.id;
      }
      leaves.push(
        await sha256Bytes(
          concat(Uint8Array.of(0), encoder.encode(canonical), encoder.encode(row.signature)),
        ),
      );
    }
    if (badSignature) sigProblems.push(`booth ${boothId}: selection ${badSignature}`);

    const tally = tallyOf.get(boothId)?.content;
    if (!tally) {
      merkleProblems.push(`booth ${boothId}: no Booth Tally`);
    } else {
      if (rows.length !== tally.selection_rows) {
        merkleProblems.push(
          `booth ${boothId}: ${rows.length} rows, tally says ${tally.selection_rows}`,
        );
      } else if ((await merkleRoot(leaves)) !== tally.merkle_root) {
        merkleProblems.push(`booth ${boothId}: Merkle root differs from the Booth Tally`);
      }
    }

    // Ballot-answer rule and recount inputs.
    const posts = postsOfBooth.get(boothId) ?? [];
    const mapped = new Map(posts.map((p) => [p.post_id, p]));
    const perPost = new Map();
    for (const row of rows) {
      if (!mapped.has(row.post_id)) {
        answerProblems.push({
          post: row.post_id,
          text: `booth ${boothId}: selection on an unmapped Post`,
        });
        continue;
      }
      const entry = perPost.get(row.post_id) ?? { candidate: 0, nota: 0 };
      if (row.is_nota) entry.nota += 1;
      else entry.candidate += 1;
      perPost.set(row.post_id, entry);

      const total = counts.get(row.post_id) ?? { candidates: {}, nota: 0 };
      if (row.is_nota) total.nota += 1;
      else total.candidates[row.candidate_id] = (total.candidates[row.candidate_id] ?? 0) + 1;
      counts.set(row.post_id, total);
    }
    for (const post of posts) {
      const entry = perPost.get(post.post_id) ?? { candidate: 0, nota: 0 };
      const answers = Math.floor(entry.candidate / post.seats) + entry.nota;
      if (entry.candidate % post.seats !== 0) {
        answerProblems.push({
          post: post.post_id,
          text: `booth ${boothId}: candidate rows not divisible by seats`,
        });
      } else if (tally && answers !== tally.ballots_cast) {
        answerProblems.push({
          post: post.post_id,
          text: `booth ${boothId}: ${answers} answers but ${tally.ballots_cast} ballots cast`,
        });
      }
    }
  }

  checks.push(
    sigProblems.length === 0
      ? pass(
          "vote_signatures",
          "Every Vote Selection signature is valid",
          `${totalSelections} selections`,
        )
      : fail("vote_signatures", "Every Vote Selection signature is valid", sigProblems[0]),
  );
  checks.push(
    merkleProblems.length === 0
      ? pass("merkle", "Each booth's count and Merkle root match its Booth Tally")
      : fail(
          "merkle",
          "Each booth's count and Merkle root match its Booth Tally",
          merkleProblems[0],
        ),
  );
  {
    const real = answerProblems.filter((p) => !withheldPosts.has(p.post));
    for (const p of answerProblems.filter((p) => withheldPosts.has(p.post))) {
      notes.push(`Post ${p.post}: ${p.text} (withheld in the Result)`);
    }
    checks.push(
      real.length === 0
        ? pass("answer_rule", "Ballot answers equal ballots cast for every declared Post")
        : fail(
            "answer_rule",
            "Ballot answers equal ballots cast for every declared Post",
            real[0].text,
          ),
    );
  }

  // 8. The Result itself.
  const doc = JSON.parse(result.canonical_json);
  {
    const title = "The Result is signed by the election key and anchored in the audit chain";
    const problems = [];
    if ((await sha256Hex(result.canonical_json)) !== result.result_hash)
      problems.push("result hash");
    else if (!(await verifySignature(publicKey, result.canonical_json, result.signature))) {
      problems.push("result signature");
    } else if (!findKeyValues(audit.events, "result_hash").includes(result.result_hash)) {
      problems.push("result hash is not in the audit chain");
    }
    if (doc.setup_hash !== setup.setup_hash) problems.push("result is for another setup");
    if (doc.election_id !== electionId) problems.push("result is for another election");
    checks.push(
      problems.length === 0
        ? pass("result", title, result.result_hash)
        : fail("result", title, problems[0]),
    );
  }

  // 9-10. Recount and winner rules for every declared contested Post.
  progress("Recounting");
  const recountProblems = [];
  const winnerProblems = [];
  let declared = 0;
  for (const post of doc.posts) {
    if (post.status === "withheld" || post.status === "unopposed") continue;
    declared += 1;
    const tally = counts.get(post.postId) ?? { candidates: {}, nota: 0 };
    const candidates = post.candidates.map((c) => ({
      id: c.id,
      votes: tally.candidates[c.id] ?? 0,
    }));
    for (const [i, c] of post.candidates.entries()) {
      if (c.votes !== candidates[i].votes) {
        recountProblems.push(
          `${post.name}: ${c.name} declared ${c.votes}, recounted ${candidates[i].votes}`,
        );
      }
    }
    if (doc.nota_enabled && post.nota !== tally.nota) {
      recountProblems.push(`${post.name}: NOTA declared ${post.nota}, recounted ${tally.nota}`);
    }
    const rules = winnerRules(post.seats, candidates, tally.nota, doc.nota_enabled);
    for (const c of post.candidates) {
      if (rules.outcome[c.id] !== c.outcome)
        winnerProblems.push(
          `${post.name}: ${c.name} is ${c.outcome}, rules give ${rules.outcome[c.id]}`,
        );
    }
    if (rules.status !== post.status)
      winnerProblems.push(`${post.name}: status ${post.status}, rules give ${rules.status}`);
    if (rules.tiedSeats !== post.tiedSeats) winnerProblems.push(`${post.name}: tied seats differ`);
    if (rules.notaExceededWinner !== post.notaExceededWinner)
      winnerProblems.push(`${post.name}: NOTA flag differs`);
    if (rules.margin !== post.margin) winnerProblems.push(`${post.name}: margin differs`);
  }
  checks.push(
    declared === 0
      ? skip("recount", "A full recount equals the declared counts", "no declared contested Posts")
      : recountProblems.length === 0
        ? pass("recount", "A full recount equals the declared counts", `${declared} Posts`)
        : fail("recount", "A full recount equals the declared counts", recountProblems[0]),
  );
  checks.push(
    declared === 0
      ? skip("winners", "The winner rules give the declared outcome", "no declared contested Posts")
      : winnerProblems.length === 0
        ? pass("winners", "The winner rules give the declared outcome", `${declared} Posts`)
        : fail("winners", "The winner rules give the declared outcome", winnerProblems[0]),
  );

  return {
    format: BUNDLE_FORMAT,
    electionId,
    resultHash: result.result_hash,
    ok: checks.every((c) => c.status !== "fail"),
    checks,
    notes,
  };
}
