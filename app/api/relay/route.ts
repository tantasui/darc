import { createPublicClient, defineChain, http, isAddress, type Address, type Hex } from "viem";
import { MONAD_TESTNET, RPC_URL } from "@/config/chain";
import { ADDRESSES, describeReason, merchantAbi } from "@/lib/contracts";
import { errorMessage, relayerWallet } from "@/lib/server";

const chain = defineChain(MONAD_TESTNET);
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

type Body = {
  auth?: {
    cardId: Hex;
    merchant: Address;
    token: Address;
    amount: string;
    nonce: string;
    deadline: string;
    policyVersion: string | number;
  };
  signature?: Hex;
};

/**
 * The relayer: submits an agent-signed authorization and pays its gas.
 *
 * The agent never transacts and holds no balance — it only signs. Note that a DECLINE still
 * costs the relayer gas: that is the price of putting refusals on-chain, and it is why the
 * funder script keeps this account topped up.
 */
export async function POST(request: Request) {
  try {
    const { auth, signature } = (await request.json()) as Body;
    if (!auth || !signature) return Response.json({ error: "auth and signature are required" }, { status: 400 });
    if (!isAddress(auth.merchant)) return Response.json({ error: "invalid merchant" }, { status: 400 });

    // Only the demo merchants are accepted: this endpoint is unauthenticated, so it must not
    // become a way to route the owner's funds to an arbitrary address.
    const allowed = [ADDRESSES.mockMerchantA, ADDRESSES.mockMerchantB].map((a) => a.toLowerCase());
    if (!allowed.includes(auth.merchant.toLowerCase())) {
      return Response.json({ error: "merchant not part of the demo" }, { status: 400 });
    }

    const typed = {
      cardId: auth.cardId,
      merchant: auth.merchant,
      token: auth.token,
      amount: BigInt(auth.amount),
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
      policyVersion: BigInt(auth.policyVersion),
    };

    const relayer = relayerWallet();
    const hash = await relayer.writeContract({
      address: auth.merchant,
      abi: merchantAbi,
      functionName: "charge",
      args: [typed, signature, []],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    // charge() never reverts on a policy decline, so re-simulate at the mined block to learn
    // the outcome the transaction actually produced.
    const { result } = await publicClient.simulateContract({
      account: relayer.account,
      address: auth.merchant,
      abi: merchantAbi,
      functionName: "charge",
      args: [typed, signature, []],
      blockNumber: receipt.blockNumber - 1n,
    });
    const [ok, selector] = result as [boolean, Hex];

    return Response.json({
      ok,
      reason: ok ? null : describeReason(selector),
      hash,
      blockNumber: receipt.blockNumber.toString(),
    });
  } catch (err) {
    return Response.json({ error: errorMessage(err) }, { status: 500 });
  }
}
