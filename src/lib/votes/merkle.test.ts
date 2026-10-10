import { describe, expect, it } from "vitest";
import { merkleLeaf, merkleRoot, merkleRootOfSelections } from "./merkle";

/**
 * Golden vectors for the booth Merkle tree. The public verifier and the SQL digest must
 * produce these exact values. Leaf i is SHA-256(0x00 || '{"id":"<x>"}' || 'sig-<x>').
 */
const selection = (x: string) => ({
  id: x,
  canonicalJson: `{"id":"${x}"}`,
  signature: `sig-${x}`,
});
const leaves = ["a", "b", "c", "d", "e"].map((x) => merkleLeaf(`{"id":"${x}"}`, `sig-${x}`));

const VECTORS = {
  empty: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  one: "46767ef146f59e30b8ca0af12c521fd4ec86f0a41e80d9bfa281c01d76ca19e5",
  two: "61b9782e3a5c6b6cc2481f6299393ea3e721400de7173445c31cf0835b36a607",
  three: "01d710a83cb9cb09f08af2d4a62d8bcc598ce90ca0bef3388775da6d5395e838",
  four: "c34cdf228ba17e0e44a351c152fb3698388f78c26e37618f535252eb6be5eb04",
  five: "d87187c9e837597137550a2adfa60b463af7fd6a73ed47ca13f05a0c85d245db",
} as const;

describe("booth Merkle tree", () => {
  it("the empty tree is the hash of the empty string", () => {
    expect(merkleRoot([])).toBe(VECTORS.empty);
  });

  it("a single leaf is its own root (and is domain-separated from nodes)", () => {
    expect(merkleRoot(leaves.slice(0, 1))).toBe(VECTORS.one);
    expect(merkleLeaf('{"id":"a"}', "sig-a").toString("hex")).toBe(VECTORS.one);
  });

  it.each([
    ["two leaves", 2, VECTORS.two],
    ["three leaves (odd: last promoted)", 3, VECTORS.three],
    ["four leaves", 4, VECTORS.four],
    ["five leaves (odd at two levels)", 5, VECTORS.five],
  ])("%s", (_name, count, expected) => {
    expect(merkleRoot(leaves.slice(0, count))).toBe(expected);
  });

  it("orders selections by id, so insertion order does not matter", () => {
    const ids = ["c", "a", "e", "b", "d"].map(selection);
    expect(merkleRootOfSelections(ids)).toBe(VECTORS.five);
    expect(merkleRootOfSelections([...ids].reverse())).toBe(VECTORS.five);
  });

  it("changes when a signature or a row changes", () => {
    const base = ["a", "b", "c"].map(selection);
    const root = merkleRootOfSelections(base);
    expect(root).toBe(VECTORS.three);
    expect(
      merkleRootOfSelections([{ ...base[0]!, signature: "other" }, ...base.slice(1)]),
    ).not.toBe(root);
    expect(merkleRootOfSelections([...base, selection("d")])).not.toBe(root);
  });
});
