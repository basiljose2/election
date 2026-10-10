import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  generateSigningKeyPair,
  privateKeyFromDer,
  publicKeyToBase64Url,
  type SigningKeyPair,
} from "./signing";

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Per-election signing keys with envelope encryption.
 *
 *   private key (PKCS#8) --AES-256-GCM(DEK)--> ciphertext
 *   DEK                  --AES-256-GCM(master key)--> wrapped_dek
 *
 * The master key exists only in a server environment variable (VOTE_SIGNING_MASTER_KEY);
 * the database holds the envelope and the public key. Both layers bind the Election id as
 * additional authenticated data, so an envelope cannot be moved to another Election.
 */

export class SigningKeyError extends Error {}

export interface KeyEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  wrapped_dek: string;
  dek_iv: string;
  dek_tag: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

const aad = (electionId: string) => Buffer.from(`campus-evm/vote-signing-key/v1:${electionId}`);
const b64 = (buf: Buffer) => buf.toString("base64");
const unb64 = (text: string) => Buffer.from(text, "base64");

/** The master key: base64 of exactly 32 random bytes. */
export function parseMasterKey(value: string | undefined): Buffer {
  const key = value ? Buffer.from(value, "base64") : Buffer.alloc(0);
  if (key.length !== 32) {
    throw new SigningKeyError(
      "VOTE_SIGNING_MASTER_KEY must be set to 32 random bytes encoded as base64",
    );
  }
  return key;
}

export function encryptPrivateKey(
  masterKey: Buffer,
  electionId: string,
  privateKeyDer: Buffer,
): KeyEnvelope {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(aad(electionId));
  const ciphertext = Buffer.concat([cipher.update(privateKeyDer), cipher.final()]);

  const dekIv = randomBytes(12);
  const wrap = createCipheriv("aes-256-gcm", masterKey, dekIv);
  wrap.setAAD(aad(electionId));
  const wrapped = Buffer.concat([wrap.update(dek), wrap.final()]);

  return {
    v: 1,
    alg: "aes-256-gcm",
    wrapped_dek: b64(wrapped),
    dek_iv: b64(dekIv),
    dek_tag: b64(wrap.getAuthTag()),
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    ciphertext: b64(ciphertext),
  };
}

export function decryptPrivateKey(
  masterKey: Buffer,
  electionId: string,
  envelope: KeyEnvelope,
): Buffer {
  try {
    const unwrap = createDecipheriv("aes-256-gcm", masterKey, unb64(envelope.dek_iv));
    unwrap.setAAD(aad(electionId));
    unwrap.setAuthTag(unb64(envelope.dek_tag));
    const dek = Buffer.concat([unwrap.update(unb64(envelope.wrapped_dek)), unwrap.final()]);

    const decipher = createDecipheriv("aes-256-gcm", dek, unb64(envelope.iv));
    decipher.setAAD(aad(electionId));
    decipher.setAuthTag(unb64(envelope.tag));
    return Buffer.concat([decipher.update(unb64(envelope.ciphertext)), decipher.final()]);
  } catch {
    throw new SigningKeyError("The election signing key could not be unlocked");
  }
}

/** Creates the Election's key pair on first freeze and returns its public key. */
export async function ensureElectionSigningKey(
  tx: Queryable,
  electionId: string,
  masterKey: Buffer,
): Promise<string> {
  const existing = await tx.query<{ public_key: string }>(
    "select public_key from public.election_signing_keys where election_id = $1",
    [electionId],
  );
  if (existing.rows[0]) return existing.rows[0].public_key;

  const pair: SigningKeyPair = generateSigningKeyPair();
  const envelope = encryptPrivateKey(masterKey, electionId, pair.privateKeyDer);
  await tx.query(
    `insert into public.election_signing_keys (election_id, public_key, private_key_envelope)
     values ($1, $2, $3::jsonb)`,
    [electionId, pair.publicKey, JSON.stringify(envelope)],
  );
  return pair.publicKey;
}

export interface LoadedSigningKey {
  publicKey: string;
  privateKey: KeyObject;
}

/** Unlocks the Election's signing key for casting. Held in memory for one request only. */
export async function loadElectionSigningKey(
  db: Queryable,
  electionId: string,
  masterKey: Buffer,
): Promise<LoadedSigningKey> {
  const { rows } = await db.query<{ public_key: string; private_key_envelope: KeyEnvelope }>(
    "select public_key, private_key_envelope from public.election_signing_keys where election_id = $1",
    [electionId],
  );
  const row = rows[0];
  if (!row) throw new SigningKeyError("This election has no signing key; it was not frozen");
  const der = decryptPrivateKey(masterKey, electionId, row.private_key_envelope);
  const privateKey = privateKeyFromDer(der);
  // The stored public key must match the unlocked private key.
  if (publicKeyToBase64Url(createPublicKey(privateKey)) !== row.public_key) {
    throw new SigningKeyError("The signing key does not match its published public key");
  }
  return { publicKey: row.public_key, privateKey };
}
