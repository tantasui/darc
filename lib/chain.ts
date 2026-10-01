/**
 * Chain reads, in one place.
 *
 * Everything here is `eth_call`. Public Monad RPCs cap `eth_getLogs` at a 100-block range, so
 * nothing in the product may depend on scanning events — which is exactly why refusal reasons
 * are written into the ERC-8004 attestations (see contracts/src/lib/DeclineReasons.sol).
 */
import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { ERC8004, MONAD_TESTNET, RPC_URL } from "@/config/chain";
import {
  ADDRESSES,
  cardManagerAbi,
  identityRegistryAbi,
  erc20Abi,
  reputationReaderAbi,
  reputationRegistryAbi,
  spendGateAbi,
} from "./contracts";

export const chain = defineChain(MONAD_TESTNET);
export const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
export const explorer = MONAD_TESTNET.blockExplorers.default.url;
export const txUrl = (hash: string) => `${explorer}/tx/${hash}`;
export const addressUrl = (address: string) => `${explorer}/address/${address}`;

export const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

export type CardState = {
  exists: boolean;
  agentKey: Address;
  owner: Address;
  dailyCap: bigint;
  remaining: bigint;
  revoked: boolean;
  expired: boolean;
  validUntil: number;
  issuedAt: number;
  policyVersion: number;
  agentId: string;
};

export async function loadCardState(cardId: Hex): Promise<CardState | null> {
  const card = await publicClient.readContract({
    address: ADDRESSES.cardManager,
    abi: cardManagerAbi,
    functionName: "getCard",
    args: [cardId],
  });
  if (card.agentKey === "0x0000000000000000000000000000000000000000") return null;

  const [remaining, agentId] = await Promise.all([
    publicClient.readContract({
      address: ADDRESSES.spendGate,
      abi: spendGateAbi,
      functionName: "remainingToday",
      args: [cardId],
    }),
    publicClient.readContract({
      address: ADDRESSES.cardManager,
      abi: cardManagerAbi,
      functionName: "agentIdOfCard",
      args: [cardId],
    }),
  ]);

  return {
    exists: true,
    agentKey: card.agentKey,
    owner: card.owner,
    dailyCap: card.dailyCap,
    remaining,
    revoked: card.revoked,
    expired: Number(card.validUntil) * 1000 <= Date.now(),
    validUntil: Number(card.validUntil),
    issuedAt: Number(card.issuedAt),
    policyVersion: Number(card.policyVersion),
    agentId: agentId.toString(),
  };
}

/** One merchant-written attestation on the canonical registry. */
export type Attestation = {
  client: Address;
  index: number;
  verdict: string;
  reason: string;
  value: number;
};

export async function loadAttestations(agentId: bigint | string): Promise<Attestation[]> {
  const id = BigInt(agentId);
  const clients = await publicClient.readContract({
    address: ERC8004.reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: "getClients",
    args: [id],
  });
  if (clients.length === 0) return [];

  const f = await publicClient.readContract({
    address: ERC8004.reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: "readAllFeedback",
    args: [id, clients as Address[], "", "", false],
  });
  return f[0].map((client, i) => ({
    client: client as Address,
    index: Number(f[1][i]),
    value: Number(f[2][i]),
    reason: f[4][i],
    verdict: f[5][i],
  }));
}

export async function loadAgentReport(agentKey: Address) {
  return publicClient.readContract({
    address: ADDRESSES.reputationReader,
    abi: reputationReaderAbi,
    functionName: "reportForAgentKey",
    args: [agentKey],
  });
}

export async function loadOwnerFunds(owner: Address) {
  const [mon, usd, allowance] = await Promise.all([
    publicClient.getBalance({ address: owner }),
    publicClient.readContract({
      address: ADDRESSES.paymentToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    }),
    publicClient.readContract({
      address: ADDRESSES.paymentToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, ADDRESSES.spendGate],
    }),
  ]);
  return { mon, usd, allowance };
}

export async function loadIdentity(agentId: bigint | string) {
  const id = BigInt(agentId);
  const [holder, wallet] = await Promise.all([
    publicClient
      .readContract({ address: ERC8004.identityRegistry, abi: identityRegistryAbi, functionName: "ownerOf", args: [id] })
      .catch(() => undefined),
    publicClient
      .readContract({
        address: ERC8004.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "getAgentWallet",
        args: [id],
      })
      .catch(() => undefined),
  ]);
  return { holder, wallet };
}

/** AUSD has 6 decimals, which is why SpendGate can pin a single token and still talk in dollars. */
export const fmtUsd = (v: bigint) => `$${(Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
