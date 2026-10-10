import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { appendAuditEvent } from "@/lib/audit/append";
import type { Actor } from "@/lib/auth/roles";
import { createBallotCommands } from "@/lib/commands/ballots";
import { executeCommand, type GatewayDeps } from "@/lib/commands/gateway";
import { createAppLifecycle } from "@/lib/lifecycle/app";
import { MemorySignalBus } from "@/lib/signals/memory";
import { castBallot, fetchPendingBallot, type CastingDeps } from "@/lib/votes/casting";
import { parseMasterKey } from "@/lib/votes/keys";
import { merkleRootOfSelections } from "@/lib/votes/merkle";
import { canonicalSelection, signSelection } from "@/lib/votes/signing";
import { loadBoothTally, readBoothDigest, verifyTally } from "@/lib/votes/tally";
import { adminPool, appPool, auditEvents } from "../support/fixtures";
import { buildVotingWorld, validAnswers, type VotingWorld } from "../support/voting-world";

const app = appPool();
const admin = adminPool();
const bus = new MemorySignalBus();
const ballots = createBallotCommands(bus);
const lifecycle = createAppLifecycle(bus);
const masterKey = parseMasterKey(process.env.VOTE_SIGNING_MASTER_KEY);

afterAll(async () => {
  await Promise.all([app.end(), admin.end()]);
});

const now = () => new Date();
const gw = (actor: Actor): Partial<GatewayDeps> => ({
  db: app,
  now,
  authenticate: async () => actor,
  appendAudit: appendAuditEvent,
});
const castingDeps: CastingDeps = {
  db: app,
  now,
  appendAudit: appendAuditEvent,
  publisher: bus,
  masterKey,
};

/** Issues a ballot, has the terminal fetch it, and casts the given answers. */
async function castOne(w: VotingWorld, answers = validAnswers(w)) {
  await executeCommand(
    ballots.issueBallotSession,
    { boothId: w.boothId, masterToken: w.masterToken },
    gw(w.po),
  );
  const pending = await fetchPendingBallot({ db: app }, w.voting);
  if (pending.status !== "pending") throw new Error("no pending ballot");
  const result = await castBallot(castingDeps, w.voting, {
    castToken: pending.castToken,
    idempotencyKey: randomUUID().replace(/-/g, ""),
    answers,
  });
  expect(result.status).toBe("cast");
}

const close = (w: VotingWorld) =>
  executeCommand(lifecycle.closePoll, { electionId: w.electionId, boothId: w.boothId }, gw(w.po));

/** The Merkle root recomputed in TypeScript from the stored rows (admin sees them). */
async function rootFromRows(w: VotingWorld) {
  const { rows } = await admin.query(
    `select id, election_id, booth_id, post_id, candidate_id, is_nota, signature
       from public.vote_selections where booth_id = $1 and not is_mock`,
    [w.boothId],
  );
  return merkleRootOfSelections(
    rows.map((r) => ({
      id: r.id as string,
      canonicalJson: canonicalSelection({
        id: r.id,
        election_id: r.election_id,
        booth_id: r.booth_id,
        post_id: r.post_id,
        candidate_id: r.candidate_id,
        is_nota: r.is_nota,
        is_mock: false,
        mock_round: null,
      }),
      signature: r.signature as string,
    })),
  );
}

const publicKey = async (w: VotingWorld) => w.publicKey;

describe("Booth Tally at close", () => {
  it("a normal close creates a signed tally with totals and no candidate counts", async () => {
    const w = await buildVotingWorld(admin);
    await castOne(w);
    await castOne(w, validAnswers(w, { president: "nota", council: [1, 2] }));
    await castOne(w, validAnswers(w, { president: 1, council: "nota" }));

    // One cancelled ballot.
    await executeCommand(
      ballots.issueBallotSession,
      { boothId: w.boothId, masterToken: w.masterToken },
      gw(w.po),
    );
    await executeCommand(
      ballots.cancelBallotSession,
      { boothId: w.boothId, masterToken: w.masterToken, reason: "voter_left" },
      gw(w.po),
    );
    await close(w);

    const tally = await loadBoothTally(app, w.boothId);
    expect(tally).not.toBeNull();
    expect(tally!.status).toBe("pass");
    expect(tally!.content).toMatchObject({
      version: 1,
      election_id: w.electionId,
      booth_id: w.boothId,
      ballots_cast: 3,
      ballots_cancelled: 1,
      mock_rounds: 0,
      selection_rows: 8, // 1+2 candidate rows, NOTA+2, 1+NOTA
      failures: [],
    });
    expect(tally!.content.posts).toEqual(
      expect.arrayContaining([
        { post_id: w.presidentId, answers: 3 },
        { post_id: w.councilId, answers: 3 },
      ]),
    );

    // Signed with the Election's key; the document names no candidate or NOTA.
    expect(verifyTally(await publicKey(w), tally!.canonicalJson, tally!.signature)).toBe(true);
    expect(tally!.canonicalJson).not.toMatch(/candidate|nota/i);
    for (const id of [...w.presidents, ...w.councillors]) {
      expect(tally!.canonicalJson).not.toContain(id);
    }

    // The close is audited with the tally hash.
    const events = await auditEvents(admin, {
      electionId: w.electionId,
      eventType: "booth.poll_closed",
    });
    expect(JSON.stringify(events[0]!.payload)).toContain(tally!.tallyHash);
  });

  it("the SQL digest and the TypeScript Merkle package give the same root", async () => {
    const w = await buildVotingWorld(admin);
    for (let i = 0; i < 5; i++) await castOne(w, validAnswers(w, { president: i % 3 }));
    await close(w);

    const digest = await readBoothDigest(app, w.boothId);
    expect(digest.selection_rows).toBe(15); // 5 ballots x (1 + 2) candidate rows
    expect(digest.bad_signatures).toBe(0);
    expect(digest.unmapped_rows).toBe(0);
    expect(digest.merkle_root).toBe(await rootFromRows(w));
  });

  it("an empty booth has the empty-tree root and passes", async () => {
    const w = await buildVotingWorld(admin);
    await close(w);
    const tally = await loadBoothTally(app, w.boothId);
    expect(tally!.status).toBe("pass");
    expect(tally!.content.selection_rows).toBe(0);
    expect(tally!.content.merkle_root).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("a force close also creates a tally, after cancelling the pending ballot", async () => {
    const w = await buildVotingWorld(admin);
    await castOne(w);
    await executeCommand(
      ballots.issueBallotSession,
      { boothId: w.boothId, masterToken: w.masterToken },
      gw(w.po),
    );
    await executeCommand(
      lifecycle.forceClosePoll,
      { electionId: w.electionId, boothId: w.boothId, reason: "power failure at the booth" },
      gw(w.ro),
    );
    const tally = await loadBoothTally(app, w.boothId);
    expect(tally!.status).toBe("pass");
    expect(tally!.content).toMatchObject({ ballots_cast: 1, ballots_cancelled: 1 });
  });

  it("is FAILED, naming the Post, when answers do not match the ballots cast", async () => {
    const w = await buildVotingWorld(admin);
    await castOne(w);
    await castOne(w);
    // One more ballot is counted than has answers (a withheld selection).
    await admin.query(
      "update public.booth_counters set ballots_cast = ballots_cast + 1 where booth_id = $1",
      [w.boothId],
    );
    await close(w); // the booth still closes

    const tally = await loadBoothTally(app, w.boothId);
    expect(tally!.status).toBe("failed");
    expect(tally!.content.failures).toEqual(
      expect.arrayContaining([
        { check: "answers_match_ballots", post_id: w.presidentId, expected: 3, actual: 2 },
        { check: "answers_match_ballots", post_id: w.councilId, expected: 3, actual: 2 },
      ]),
    );
    expect(verifyTally(await publicKey(w), tally!.canonicalJson, tally!.signature)).toBe(true);
  });

  it("is FAILED for a forged signature and a selection on an unmapped Post", async () => {
    const w = await buildVotingWorld(admin, { unmappedPost: true });
    await castOne(w);
    const other = w.unmapped!.postId;
    const candidate = w.unmapped!.candidateId;
    // Post-close style forgery: a row with a signature that does not verify, on an unmapped Post.
    await admin.query(
      `insert into public.vote_selections (election_id, booth_id, post_id, candidate_id, signature)
       values ($1, $2, $3, $4, $5)`,
      [w.electionId, w.boothId, other, candidate, "A".repeat(86)],
    );
    await close(w);

    const tally = await loadBoothTally(app, w.boothId);
    expect(tally!.status).toBe("failed");
    const checks = tally!.content.failures.map((f) => f.check);
    expect(checks).toContain("selection_signatures");
    expect(checks).toContain("no_unmapped_selections");
  });

  it("a Vote Selection signed by another key is a bad signature", async () => {
    const w = await buildVotingWorld(admin);
    await castOne(w);
    const forged = {
      id: randomUUID(),
      election_id: w.electionId,
      booth_id: w.boothId,
      post_id: w.presidentId,
      candidate_id: w.presidents[0]!,
      is_nota: false,
      is_mock: false,
      mock_round: null,
    };
    const { generateSigningKeyPair, privateKeyFromDer } = await import("@/lib/votes/signing");
    const pair = generateSigningKeyPair();
    await admin.query(
      `insert into public.vote_selections (id, election_id, booth_id, post_id, candidate_id, signature)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        forged.id,
        forged.election_id,
        forged.booth_id,
        forged.post_id,
        forged.candidate_id,
        signSelection(privateKeyFromDer(pair.privateKeyDer), forged),
      ],
    );
    await close(w);
    const digest = await readBoothDigest(app, w.boothId);
    expect(digest.bad_signatures).toBe(1);
  });

  it("cancelling a mock ballot does not count towards the real cancelled total", async () => {
    const w = await buildVotingWorld(admin, { booth: "mock_poll" });
    await executeCommand(
      ballots.issueBallotSession,
      { boothId: w.boothId, masterToken: w.masterToken },
      gw(w.po),
    );
    await executeCommand(
      ballots.cancelBallotSession,
      { boothId: w.boothId, masterToken: w.masterToken, reason: "voter_left" },
      gw(w.po),
    );
    const { rows } = await admin.query(
      "select ballots_cancelled::int n from public.booth_counters where booth_id = $1",
      [w.boothId],
    );
    expect(rows[0].n).toBe(0);
  });

  it("the digest is refused while the booth is open", async () => {
    const w = await buildVotingWorld(admin);
    await expect(readBoothDigest(app, w.boothId)).rejects.toMatchObject({ code: "42501" });
  });
});
