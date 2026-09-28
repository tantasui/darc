import { createPublicClient, defineChain, http, isAddress, keccak256, encodeAbiParameters, type Address } from "viem";
import { MONAD_TESTNET, RPC_URL } from "@/config/chain";
import { ADDRESSES, cardManagerAbi } from "@/lib/contracts";
import { errorMessage, ownerWallet } from "@/lib/server";

const chain = defineChain(MONAD_TESTNET);
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

/** Merkle leaf for a single-merchant policy: the root IS the leaf, and the proof is empty. */
function merchantLeaf(merchant: Address) {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }], [keccak256(encodeAbiParameters([{ type: "address" }], [merchant]))]),
  );
}

/** Issues a $50/day card scoped to merchant A. Owner action — passkey-gated in the real console. */
export async function POST(request: Request) {
  try {
    const { agentKey } = (await request.json()) as { agentKey?: string };
    if (!agentKey || !isAddress(agentKey)) {
      return Response.json({ error: "a valid agentKey is required" }, { status: 400 });
    }

    const owner = ownerWallet();
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);

    const hash = await owner.writeContract({
      address: ADDRESSES.cardManager,
      abi: cardManagerAbi,
      functionName: "issueCard",
      args: [agentKey, 50_000_000n, merchantLeaf(ADDRESSES.mockMerchantA), validUntil, "ipfs://agentcard-demo"],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const cardId = await publicClient.readContract({
      address: ADDRESSES.cardManager,
      abi: cardManagerAbi,
      functionName: "cardIdFor",
      args: [owner.account.address, agentKey],
    });
    const agentId = await publicClient.readContract({
      address: ADDRESSES.cardManager,
      abi: cardManagerAbi,
      functionName: "agentIdOfCard",
      args: [cardId],
    });

    return Response.json({ cardId, agentId: agentId.toString(), hash });
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}
