/**
 * Live end-to-end demo against the deployed contracts: real transactions on Monad Testnet.
 *
 * Runs the exact flow pinned by `DemoScript.t.sol`:
 *   issue card -> $20 approved -> $200 declined (cap) -> merchant B declined (scope) -> revoke
 *
 * Run this ONCE before demoing. It leaves a real on-chain trail for judges to inspect, and it
 * rehearses the flow so the live run is not the first one.
 *
 * Env:
 *   OWNER_PRIVATE_KEY     owner EOA (in the app this is Mera-derived from the passkey)
 *   RELAYER_PRIVATE_KEY   submits every charge and pays gas, including for declines
 *   AGENT_PRIVATE_KEY     optional; a fresh disposable key is generated if unset
 *   MONAD_TESTNET_RPC     optional RPC override
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  encodePacked,
  keccak256,
  encodeAbiParameters,
  parseAbi,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { MONAD_TESTNET, RPC_URL } from "../config/chain.ts";
import { ADDRESSES } from "../config/addresses.ts";

const chain = defineChain(MONAD_TESTNET);
const explorer = MONAD_TESTNET.blockExplorers.default.url;

const usdAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
/** AUSD is real, so there is no mint — claim from Agora's public testnet faucet instead. */
const faucetAbi = parseAbi(["function requestFunds(address recipient)"]);
const cardManagerAbi = parseAbi([
  "function issueCard(address agentKey, uint256 dailyCap, bytes32 merchantRoot, uint64 validUntil, string agentURI) returns (bytes32, uint256)",
  "function revoke(bytes32 cardId)",
  "function cardIdFor(address owner, address agentKey) view returns (bytes32)",
  "function agentIdOfCard(bytes32) view returns (uint256)",
  "struct Card { address agentKey; address owner; uint256 dailyCap; bytes32 merchantRoot; uint64 validUntil; uint64 issuedAt; bool revoked; uint64 policyVersion; }",
  "function getCard(bytes32 cardId) view returns (Card)",
]);
const merchantAbi = parseAbi([
  "function charge((bytes32 cardId,address merchant,address token,uint256 amount,uint256 nonce,uint256 deadline,uint64 policyVersion) auth, bytes agentSig, bytes32[] merchantProof) returns (bool, bytes4)",
]);
const readerAbi = parseAbi([
  "struct AgentReport { bool found; uint256 agentId; bytes32 cardId; address owner; uint64 approvedCount; uint64 declinedCount; bool revoked; bool expired; uint64 activeSince; uint64 clientCount; }",
  "function reportForAgentKey(address agentKey) view returns (AgentReport)",
]);

/** Decline reasons, keyed by custom-error selector. Mirrors SpendGate's error taxonomy. */
const REASONS: Record<string, string> = Object.fromEntries(
  [
    "CardNotFound()",
    "CardRevoked()",
    "CardExpired()",
    "DeadlineExpired()",
    "TokenNotAllowed()",
    "PolicyVersionStale()",
    "BadAgentSignature()",
    "NonceUsed()",
    "MerchantNotAllowed()",
    "DailyCapExceeded()",
  ].map((sig) => [keccak256(new TextEncoder().encode(sig)).slice(0, 10), sig.replace("()", "")]),
);

const merchantLeaf = (m: Address) =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }], [keccak256(encodeAbiParameters([{ type: "address" }], [m]))]));

const usd = (v: bigint) => `$${formatUnits(v, 6)}`;
const link = (hash: Hex) => `${explorer}/tx/${hash}`;

function need(name: string): Hex {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required. See DEPLOY.md step 7.`);
  return v as Hex;
}

async function main() {
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

  const owner = privateKeyToAccount(need("OWNER_PRIVATE_KEY"));
  const relayer = privateKeyToAccount(need("RELAYER_PRIVATE_KEY"));
  // Agent keys are fresh, random and disposable -- never derived from the passkey.
  const agent = privateKeyToAccount((process.env.AGENT_PRIVATE_KEY as Hex) ?? generatePrivateKey());

  const ownerWallet = createWalletClient({ account: owner, chain, transport: http(RPC_URL) });
  const relayerWallet = createWalletClient({ account: relayer, chain, transport: http(RPC_URL) });

  const wait = async (hash: Hex, label: string) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`   ${label}  ${receipt.status === "success" ? "ok" : "FAILED"}  ${link(hash)}`);
    return receipt;
  };

  console.log(`\nAgentCard live demo — Monad Testnet (chain ${chain.id})`);
  console.log(`   owner   ${owner.address}\n   relayer ${relayer.address}\n   agent   ${agent.address}\n`);

  for (const [label, addr] of [["owner", owner.address], ["relayer", relayer.address]] as const) {
    const bal = await publicClient.getBalance({ address: addr });
    if (bal === 0n) throw new Error(`${label} (${addr}) has no MON. Run: npm run fund`);
  }

  // --- setup: fund the owner with mUSD and grant a BOUNDED approval -------------
  console.log("0. Claiming AUSD and approving SpendGate (bounded, not infinite)");
  const held = await publicClient.readContract({
    address: ADDRESSES.paymentToken,
    abi: usdAbi,
    functionName: "balanceOf",
    args: [owner.address],
  });
  if (held < 100_000_000n) {
    await wait(
      await ownerWallet.writeContract({
        address: ADDRESSES.ausdFaucet,
        abi: faucetAbi,
        functionName: "requestFunds",
        args: [owner.address],
      }),
      "faucet  ",
    );
  }
  await wait(
    await ownerWallet.writeContract({ address: ADDRESSES.paymentToken, abi: usdAbi, functionName: "approve", args: [ADDRESSES.spendGate, 500_000_000n] }),
    "approve ",
  );

  // --- 1. issue the card (one passkey prompt in the app) -----------------------
  console.log("\n1. Owner issues a card: $50/day, merchants {A}");
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  await wait(
    await ownerWallet.writeContract({
      address: ADDRESSES.cardManager,
      abi: cardManagerAbi,
      functionName: "issueCard",
      args: [agent.address, 50_000_000n, merchantLeaf(ADDRESSES.mockMerchantA), validUntil, "ipfs://agentcard-demo"],
    }),
    "issueCard",
  );

  const cardId = await publicClient.readContract({
    address: ADDRESSES.cardManager, abi: cardManagerAbi, functionName: "cardIdFor", args: [owner.address, agent.address],
  });
  const card = await publicClient.readContract({
    address: ADDRESSES.cardManager, abi: cardManagerAbi, functionName: "getCard", args: [cardId],
  });
  console.log(`   cardId ${cardId}\n   agentId ${await publicClient.readContract({ address: ADDRESSES.cardManager, abi: cardManagerAbi, functionName: "agentIdOfCard", args: [cardId] })}`);

  // The agent only ever signs SpendAuths -- it never sends a transaction.
  const attempt = async (step: string, merchant: Address, amount: bigint, nonce: bigint) => {
    const auth = {
      cardId,
      merchant,
      token: ADDRESSES.paymentToken,
      amount,
      nonce,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
      policyVersion: card.policyVersion,
    };
    const agentSig = await agent.signTypedData({
      domain: { name: "AgentCard", version: "1", chainId: chain.id, verifyingContract: ADDRESSES.spendGate },
      types: {
        SpendAuth: [
          { name: "cardId", type: "bytes32" }, { name: "merchant", type: "address" },
          { name: "token", type: "address" }, { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
          { name: "policyVersion", type: "uint64" },
        ],
      },
      primaryType: "SpendAuth",
      message: auth,
    });

    // Simulate first so we can report the decline reason before spending gas on it.
    const { result } = await publicClient.simulateContract({
      account: relayer, address: merchant, abi: merchantAbi, functionName: "charge",
      args: [auth, agentSig, []],
    });
    const [ok, selector] = result as [boolean, Hex];

    console.log(`\n${step}  ${usd(amount)} at ${merchant}`);
    const hash = await relayerWallet.writeContract({
      address: merchant, abi: merchantAbi, functionName: "charge", args: [auth, agentSig, []],
    });
    await wait(hash, ok ? "APPROVED" : `DECLINED ${REASONS[selector] ?? selector}`);
  };

  await attempt("2. Agent buys in-policy      ", ADDRESSES.mockMerchantA, 20_000_000n, 1n);
  await attempt("3. Agent tries over cap      ", ADDRESSES.mockMerchantA, 200_000_000n, 2n);
  await attempt("4. Agent tries merchant B    ", ADDRESSES.mockMerchantB, 5_000_000n, 3n);

  // --- 5. the verifier's view --------------------------------------------------
  const report = await publicClient.readContract({
    address: ADDRESSES.reputationReader, abi: readerAbi, functionName: "reportForAgentKey", args: [agent.address],
  });
  console.log(`\n5. Verifier view for ${agent.address}`);
  console.log(`   approved ${report.approvedCount}  declined ${report.declinedCount}  revoked ${report.revoked}  clients ${report.clientCount}`);

  // --- 6. revoke ---------------------------------------------------------------
  console.log("\n6. Owner revokes the card (one passkey prompt in the app)");
  await wait(
    await ownerWallet.writeContract({ address: ADDRESSES.cardManager, abi: cardManagerAbi, functionName: "revoke", args: [cardId] }),
    "revoke  ",
  );
  await attempt("   Agent tries again        ", ADDRESSES.mockMerchantA, 1_000_000n, 4n);

  const final = await publicClient.readContract({
    address: ADDRESSES.reputationReader, abi: readerAbi, functionName: "reportForAgentKey", args: [agent.address],
  });
  console.log(`\nFinal: approved ${final.approvedCount}  declined ${final.declinedCount}  revoked ${final.revoked}`);
  console.log(`Agent balances — MON ${await publicClient.getBalance({ address: agent.address })}, AUSD ${await publicClient.readContract({ address: ADDRESSES.paymentToken, abi: usdAbi, functionName: "balanceOf", args: [agent.address] })}\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
