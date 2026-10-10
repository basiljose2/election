import { describe, expect, it } from "vitest";
import {
  canonicalSelection,
  generateSigningKeyPair,
  privateKeyFromDer,
  signSelection,
  verifySelection,
  type SelectionContent,
} from "./signing";

/**
 * Golden vectors, produced independently with plain node:crypto (seed = 32 bytes of 0x07)
 * so the public verifier can reproduce them without this code base.
 */
const SEED_PKCS8 = Buffer.concat([
  Buffer.from("302e020100300506032b657004220420", "hex"),
  Buffer.alloc(32, 7),
]);
const PUBLIC_KEY = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";

const REAL: SelectionContent = {
  id: "00000000-0000-4000-8000-000000000001",
  election_id: "11111111-1111-4111-8111-111111111111",
  booth_id: "22222222-2222-4222-8222-222222222222",
  post_id: "33333333-3333-4333-8333-333333333333",
  candidate_id: "44444444-4444-4444-8444-444444444444",
  is_nota: false,
  is_mock: false,
  mock_round: null,
};
const REAL_JSON =
  '{"booth_id":"22222222-2222-4222-8222-222222222222","candidate_id":"44444444-4444-4444-8444-444444444444","election_id":"11111111-1111-4111-8111-111111111111","id":"00000000-0000-4000-8000-000000000001","is_mock":false,"is_nota":false,"mock_round":null,"post_id":"33333333-3333-4333-8333-333333333333"}';
const REAL_SIGNATURE =
  "C2EZfFk3wcKdLhCOYqP-YgonvqQzejbYqIZHPsNB3OOZk4QLElzHgDw2NQ7WHM6Lgb_kYWE1TkbonGSQMWEECQ";

const MOCK_NOTA: SelectionContent = {
  ...REAL,
  id: "00000000-0000-4000-8000-000000000002",
  candidate_id: null,
  is_nota: true,
  is_mock: true,
  mock_round: 3,
};
const MOCK_NOTA_JSON =
  '{"booth_id":"22222222-2222-4222-8222-222222222222","candidate_id":null,"election_id":"11111111-1111-4111-8111-111111111111","id":"00000000-0000-4000-8000-000000000002","is_mock":true,"is_nota":true,"mock_round":3,"post_id":"33333333-3333-4333-8333-333333333333"}';
const MOCK_NOTA_SIGNATURE =
  "tEk2zVmCeB_uKkDro5lQ2MRq78uXjSt573JAJcaNMgWIDafQyPa77rkuQL-unAKJQIHh1az9F3HpvAuJwVHRCQ";

describe("canonical selection", () => {
  it("matches the golden serialisation", () => {
    expect(canonicalSelection(REAL)).toBe(REAL_JSON);
    expect(canonicalSelection(MOCK_NOTA)).toBe(MOCK_NOTA_JSON);
  });

  it("signs only the listed fields", () => {
    const extra = { ...REAL, session_id: "x", created_at: "now" } as unknown as SelectionContent;
    expect(canonicalSelection(extra)).toBe(REAL_JSON);
  });
});

describe("Vote Selection signatures", () => {
  const key = privateKeyFromDer(SEED_PKCS8);

  it("reproduces the golden signatures (Ed25519 is deterministic)", () => {
    expect(signSelection(key, REAL)).toBe(REAL_SIGNATURE);
    expect(signSelection(key, MOCK_NOTA)).toBe(MOCK_NOTA_SIGNATURE);
  });

  it("verifies golden vectors with the published public key", () => {
    expect(verifySelection(PUBLIC_KEY, REAL, REAL_SIGNATURE)).toBe(true);
    expect(verifySelection(PUBLIC_KEY, MOCK_NOTA, MOCK_NOTA_SIGNATURE)).toBe(true);
  });

  it("rejects any change to the content (forged or altered row)", () => {
    for (const changed of [
      { ...REAL, candidate_id: "55555555-5555-4555-8555-555555555555" },
      { ...REAL, post_id: "66666666-6666-4666-8666-666666666666" },
      { ...REAL, booth_id: "66666666-6666-4666-8666-666666666666" },
      { ...REAL, is_mock: true, mock_round: 1 },
      { ...REAL, id: "00000000-0000-4000-8000-000000000009" },
      { ...REAL, candidate_id: null, is_nota: true },
    ]) {
      expect(verifySelection(PUBLIC_KEY, changed, REAL_SIGNATURE)).toBe(false);
    }
  });

  it("rejects a signature from another key, and malformed signatures", () => {
    const other = generateSigningKeyPair();
    const foreign = signSelection(privateKeyFromDer(other.privateKeyDer), REAL);
    expect(verifySelection(PUBLIC_KEY, REAL, foreign)).toBe(false);
    expect(verifySelection(other.publicKey, REAL, foreign)).toBe(true);
    for (const bad of ["", "short", "!".repeat(86), REAL_SIGNATURE.slice(0, -1)]) {
      expect(verifySelection(PUBLIC_KEY, REAL, bad)).toBe(false);
    }
  });

  it("a generated key pair round-trips", () => {
    const pair = generateSigningKeyPair();
    expect(pair.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const signature = signSelection(privateKeyFromDer(pair.privateKeyDer), MOCK_NOTA);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(verifySelection(pair.publicKey, MOCK_NOTA, signature)).toBe(true);
  });
});
