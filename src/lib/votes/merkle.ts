import { createHash } from "node:crypto";

/**
 * The Merkle tree over a booth's real Vote Selections. The SQL function booth_integrity_digest
 * and the public verifier (transparency-portal) compute exactly the same root; the test
 * vectors in merkle.test.ts are published with this algorithm.
 *
 *   leaf   = SHA-256( 0x00 || canonical_selection_json || signature )     (both as UTF-8)
 *   parent = SHA-256( 0x01 || left || right )
 *   leaves are ordered by selection id (as text); an odd last node is promoted unchanged;
 *   the root of an empty tree is SHA-256 of the empty string.
 */

const sha256 = (...parts: Array<Buffer | Uint8Array>) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

export function merkleLeaf(canonicalSelectionJson: string, signature: string): Buffer {
  return sha256(
    LEAF_PREFIX,
    Buffer.from(canonicalSelectionJson, "utf8"),
    Buffer.from(signature, "utf8"),
  );
}

/** Root (hex) of already-ordered leaves. */
export function merkleRoot(leaves: readonly Buffer[]): string {
  if (leaves.length === 0) return sha256(Buffer.alloc(0)).toString("hex");
  let level = [...leaves];
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right ? sha256(NODE_PREFIX, left, right) : left);
    }
    level = next;
  }
  return level[0]!.toString("hex");
}

export interface MerkleSelection {
  id: string;
  canonicalJson: string;
  signature: string;
}

/** Root of a set of selections: sorts by id, then hashes. */
export function merkleRootOfSelections(selections: readonly MerkleSelection[]): string {
  const ordered = [...selections].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return merkleRoot(ordered.map((s) => merkleLeaf(s.canonicalJson, s.signature)));
}
