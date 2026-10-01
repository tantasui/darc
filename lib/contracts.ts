/** Contract bindings for the web app. Addresses come from the generated config. */
import { parseAbi, keccak256, toBytes, type Hex } from "viem";
import { ADDRESSES } from "@/config/addresses";

/** First block of the deployment, so log queries do not scan the whole chain. */
export const DEPLOY_BLOCK = 65969571n;

export const reputationReaderAbi = parseAbi([
  "struct AgentReport { bool found; uint256 agentId; bytes32 cardId; address owner; uint64 approvedCount; uint64 declinedCount; bool revoked; bool expired; uint64 activeSince; uint64 clientCount; }",
  "function reportForAgentKey(address agentKey) view returns (AgentReport)",
  "function isTrusted(address agentKey) view returns (bool)",
]);

export const cardManagerAbi = parseAbi([
  "struct Card { address agentKey; address owner; uint256 dailyCap; bytes32 merchantRoot; uint64 validUntil; uint64 issuedAt; bool revoked; uint64 policyVersion; }",
  "function getCard(bytes32 cardId) view returns (Card)",
  "function agentIdOfCard(bytes32) view returns (uint256)",
  "function cardIdOfAgentKey(address) view returns (bytes32)",
  "function cardIdFor(address owner, address agentKey) pure returns (bytes32)",
  "function issueCard(address agentKey, uint256 dailyCap, bytes32 merchantRoot, uint64 validUntil, string agentURI) returns (bytes32, uint256)",
  "function revoke(bytes32 cardId)",
]);

/** The only thing an agent ever signs. Must match SPEND_AUTH_TYPEHASH in Solidity. */
export const SPEND_AUTH_TYPES = {
  SpendAuth: [
    { name: "cardId", type: "bytes32" },
    { name: "merchant", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "policyVersion", type: "uint64" },
  ],
} as const;

export const merchantAbi = parseAbi([
  "function charge((bytes32 cardId,address merchant,address token,uint256 amount,uint256 nonce,uint256 deadline,uint64 policyVersion) auth, bytes agentSig, bytes32[] merchantProof) returns (bool, bytes4)",
]);

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/**
 * The AUSD testnet faucet. Its ABI is not published, so this signature was recovered from
 * the proxy's implementation bytecode and confirmed by a live claim: it sends 10,000 AUSD to
 * the given address, with a short cooldown.
 */
export const ausdFaucetAbi = parseAbi(["function requestFunds(address recipient)"]);

export const spendGateAbi = parseAbi([
  "function remainingToday(bytes32 cardId) view returns (uint256)",
  "event SpendApproved(bytes32 indexed cardId, address indexed merchant, uint256 amount, uint256 nonce, uint256 spentToday)",
]);

export const spendRouterAbi = parseAbi([
  "event SpendDeclined(bytes32 indexed cardId, address indexed merchant, uint256 amount, uint256 nonce, bytes4 reasonSelector)",
]);

/** Canonical ERC-8004 registries — the same contracts any third party would query. */
export const identityRegistryAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);

export const reputationRegistryAbi = parseAbi([
  "function getClients(uint256 agentId) view returns (address[])",
  "function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)",
]);

/**
 * SpendGate's custom errors, by selector. SpendRouter records the selector on-chain, so
 * this is how a refusal becomes readable. Pinned in Solidity by
 * contracts/test/CrossLanguageConstants.t.sol, so drift breaks CI rather than this page.
 */
export const DECLINE_REASONS: Record<string, string> = Object.fromEntries(
  [
    "CardNotFound",
    "CardRevoked",
    "CardExpired",
    "DeadlineExpired",
    "TokenNotAllowed",
    "PolicyVersionStale",
    "BadAgentSignature",
    "NonceUsed",
    "MerchantNotAllowed",
    "DailyCapExceeded",
  ].map((name) => [keccak256(toBytes(`${name}()`)).slice(0, 10), name]),
);

export function describeReason(selector: Hex): string {
  return DECLINE_REASONS[selector.toLowerCase()] ?? `unknown (${selector})`;
}

export { ADDRESSES };
