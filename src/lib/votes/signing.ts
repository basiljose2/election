import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalJson } from "@/lib/audit/canonical-json";

/**
 * Vote Selection signatures (Ed25519), shared by the server and the public verifier.
 *
 * A signature covers the canonical JSON of exactly these fields and nothing else, so anyone
 * holding a stored row and the election's published public key can check it:
 *   { booth_id, candidate_id | null, election_id, id, is_mock, is_nota, mock_round | null, post_id }
 * (keys sorted, no whitespace; see docs/VOTE_FORMAT.md)
 */

export interface SelectionContent {
  id: string;
  election_id: string;
  booth_id: string;
  post_id: string;
  /** null when the selection is NOTA. */
  candidate_id: string | null;
  is_nota: boolean;
  is_mock: boolean;
  /** null for real selections. */
  mock_round: number | null;
}

/** The exact bytes that are signed. */
export function canonicalSelection(selection: SelectionContent): string {
  return canonicalJson({
    id: selection.id,
    election_id: selection.election_id,
    booth_id: selection.booth_id,
    post_id: selection.post_id,
    candidate_id: selection.candidate_id,
    is_nota: selection.is_nota,
    is_mock: selection.is_mock,
    mock_round: selection.mock_round,
  });
}

export interface SigningKeyPair {
  /** Raw 32-byte public key, base64url. Published with the Setup Hash. */
  publicKey: string;
  /** PKCS#8 DER private key. Never leaves the server; stored only envelope-encrypted. */
  privateKeyDer: Buffer;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKeyToBase64Url(publicKey),
    privateKeyDer: privateKey.export({ format: "der", type: "pkcs8" }),
  };
}

export function publicKeyToBase64Url(key: KeyObject): string {
  const x = key.export({ format: "jwk" }).x;
  if (!x) throw new Error("not an Ed25519 public key");
  return x;
}

export function publicKeyFromBase64Url(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
}

export function privateKeyFromDer(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** Ed25519 signature over the canonical selection, base64url (86 characters). */
export function signSelection(privateKey: KeyObject, selection: SelectionContent): string {
  return sign(null, Buffer.from(canonicalSelection(selection), "utf8"), privateKey).toString(
    "base64url",
  );
}

export function verifySelection(
  publicKey: string,
  selection: SelectionContent,
  signature: string,
): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    return verify(
      null,
      Buffer.from(canonicalSelection(selection), "utf8"),
      publicKeyFromBase64Url(publicKey),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}
