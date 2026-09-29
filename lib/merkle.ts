/**
 * Merchant scoping, built client-side so the owner's policy never leaves the browser
 * un-hashed. Must match AgentCardTypes.merchantLeaf in Solidity, which is pinned by
 * contracts/test/CrossLanguageConstants.t.sol.
 *
 * Leaves are double-hashed to prevent second-preimage attacks against internal nodes, and
 * pairs are hashed commutatively (sorted), matching OpenZeppelin's MerkleProof.
 *
 * Scale note: the console offers a handful of merchants, so a 1- or 2-leaf tree is all we
 * build. It is scoping, not confidentiality: with one merchant the root IS the leaf and is
 * trivially enumerable.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export const ANY_MERCHANT: Hex = `0x${"00".repeat(32)}`;

export function merchantLeaf(merchant: Address): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }], [keccak256(encodeAbiParameters([{ type: "address" }], [merchant]))]),
  );
}

function commutativeHash(a: Hex, b: Hex): Hex {
  const [x, y] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(`0x${x.slice(2)}${y.slice(2)}`);
}

/** `bytes32(0)` means "any merchant" — an explicit, documented wildcard. */
export function merchantRoot(merchants: readonly Address[]): Hex {
  if (merchants.length === 0) return ANY_MERCHANT;
  const leaves = merchants.map(merchantLeaf);
  if (leaves.length === 1) return leaves[0];
  return leaves.reduce((acc, leaf, i) => (i === 0 ? leaf : commutativeHash(acc, leaf)));
}

/** Proof for `merchant` within the same set. Empty when the tree is a single leaf. */
export function merchantProof(merchants: readonly Address[], merchant: Address): Hex[] {
  if (merchants.length <= 1) return [];
  const siblings = merchants.filter((m) => m.toLowerCase() !== merchant.toLowerCase());
  return siblings.map(merchantLeaf);
}
