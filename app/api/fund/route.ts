import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  isAddress,
  parseEther,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, RPC_URL, GAS } from "@/config/chain";
import { errorMessage } from "@/lib/server";

const chain = defineChain(MONAD_TESTNET);
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

/** Enough for a handful of owner actions; small on purpose so an open endpoint cannot be drained. */
const TOP_UP = parseEther("0.25");
const CEILING = parseEther("0.5");

/**
 * Pre-funds a freshly derived owner account so onboarding needs no faucet detour.
 *
 * DEMO-ONLY, like the other routes here: unauthenticated, paying from a throwaway testnet
 * key. It refuses to top up an account that already holds enough, which bounds the damage to
 * the funder's testnet balance.
 */
export async function POST(request: Request) {
  try {
    const { address } = (await request.json()) as { address?: string };
    if (!address || !isAddress(address)) {
      return Response.json({ error: "a valid address is required" }, { status: 400 });
    }

    const balance = await publicClient.getBalance({ address: address as Address });
    if (balance >= CEILING) {
      return Response.json({ funded: false, balance: formatEther(balance), reason: "already funded" });
    }

    const key = process.env.FUNDER_PRIVATE_KEY as `0x${string}` | undefined;
    if (!key) return Response.json({ error: "FUNDER_PRIVATE_KEY is not set" }, { status: 500 });

    const funder = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC_URL) });
    // Explicit gas: Monad charges the declared limit, not gas used.
    const hash = await funder.sendTransaction({ to: address as Address, value: TOP_UP, gas: GAS.transfer });
    await publicClient.waitForTransactionReceipt({ hash });

    const after = await publicClient.getBalance({ address: address as Address });
    return Response.json({ funded: true, balance: formatEther(after), hash });
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}
