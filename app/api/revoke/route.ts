import { createPublicClient, defineChain, http, type Hex } from "viem";
import { MONAD_TESTNET, RPC_URL } from "@/config/chain";
import { ADDRESSES, cardManagerAbi } from "@/lib/contracts";
import { errorMessage, ownerWallet } from "@/lib/server";

const chain = defineChain(MONAD_TESTNET);
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

/** Owner action. Instant and total: there is no un-revoke, by design. */
export async function POST(request: Request) {
  try {
    const { cardId } = (await request.json()) as { cardId?: Hex };
    if (!cardId) return Response.json({ error: "cardId is required" }, { status: 400 });

    const owner = ownerWallet();
    const hash = await owner.writeContract({
      address: ADDRESSES.cardManager,
      abi: cardManagerAbi,
      functionName: "revoke",
      args: [cardId],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    return Response.json({ hash });
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}
