/**
 * Gas funder / top-up for the AgentCard demo.
 *
 * WHY THIS EXISTS AND WHY IT IS A TOP-UP, NOT A DRIP:
 *   Mera accounts are plain EOAs -- no paymaster, no bundler -- so the owner needs MON to
 *   issue and revoke. The merchant/relayer needs MON too, and more than you would guess:
 *   the demo DELIBERATELY triggers declines, and a decline still costs the submitter gas
 *   (that is the price of putting refusals on-chain). A relayer running dry mid-demo is
 *   the most preventable failure in the room, so this checks balances against a threshold
 *   and refills only what is below it. Safe to run repeatedly, including right before demoing.
 *
 * Usage:
 *   node scripts/fund.ts --check                 # balance table only, no transactions
 *   node scripts/fund.ts                         # top up anything below threshold
 *   node scripts/fund.ts --add 0xAbC...          # include an extra address (repeatable)
 *   node scripts/fund.ts --threshold 0.5 --target 2
 *
 * Env:
 *   FUNDER_PRIVATE_KEY   faucet-funded dev key that pays for top-ups (required unless --check)
 *   OWNER_ADDRESS        owner EOA to keep funded (optional)
 *   RELAYER_ADDRESS      merchant/relayer that submits spends AND declines (optional)
 *   MONAD_TESTNET_RPC    RPC override (optional)
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseEther,
  isAddress,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, RPC_URL, GAS } from "../config/chain.ts";

const chain = defineChain(MONAD_TESTNET);

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}
function argAll(flag: string): string[] {
  return process.argv.reduce<string[]>(
    (acc, v, i) => (v === flag && process.argv[i + 1] ? [...acc, process.argv[i + 1]] : acc),
    [],
  );
}

const checkOnly = process.argv.includes("--check");
/** Refill anything below this. */
const THRESHOLD = parseEther(arg("--threshold") ?? "0.5");
/** Refill up to this. */
const TARGET = parseEther(arg("--target") ?? "2");

type Entry = { label: string; address: Address };

function collectTargets(): Entry[] {
  const entries: Entry[] = [];
  const push = (label: string, value?: string) => {
    if (!value) return;
    if (!isAddress(value)) throw new Error(`${label} is not a valid address: ${value}`);
    entries.push({ label, address: value });
  };

  push("owner", process.env.OWNER_ADDRESS);
  push("relayer/merchant", process.env.RELAYER_ADDRESS);
  argAll("--add").forEach((a, i) => push(`extra[${i}]`, a));
  return entries;
}

const pad = (s: string, n: number) => s.padEnd(n);
const mon = (v: bigint) => `${Number(formatEther(v)).toFixed(4)} MON`;

async function main() {
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  const targets = collectTargets();

  const funderKey = process.env.FUNDER_PRIVATE_KEY as `0x${string}` | undefined;
  const funder = funderKey ? privateKeyToAccount(funderKey) : undefined;
  if (funder) targets.unshift({ label: "funder", address: funder.address });

  if (targets.length === 0) {
    console.error(
      "Nothing to check. Set OWNER_ADDRESS / RELAYER_ADDRESS / FUNDER_PRIVATE_KEY, or pass --add <address>.",
    );
    process.exit(1);
  }

  const balances = await Promise.all(
    targets.map(async (t) => ({ ...t, balance: await publicClient.getBalance({ address: t.address }) })),
  );

  // Balance table: pre-demo checks are one command.
  const width = Math.max(...balances.map((b) => b.label.length), 16);
  console.log(`\nMonad Testnet (chain ${chain.id})  threshold ${mon(THRESHOLD)}  target ${mon(TARGET)}\n`);
  console.log(`  ${pad("ROLE", width)}  ${pad("ADDRESS", 42)}  ${pad("BALANCE", 14)}  STATUS`);
  console.log(`  ${"-".repeat(width)}  ${"-".repeat(42)}  ${"-".repeat(14)}  ------`);
  for (const b of balances) {
    const low = b.label !== "funder" && b.balance < THRESHOLD;
    console.log(
      `  ${pad(b.label, width)}  ${pad(b.address, 42)}  ${pad(mon(b.balance), 14)}  ${low ? "LOW" : "ok"}`,
    );
  }
  console.log("");

  const needy = balances.filter((b) => b.label !== "funder" && b.balance < THRESHOLD);

  if (checkOnly) {
    console.log(needy.length ? `${needy.length} address(es) below threshold. Re-run without --check to top up.` : "All funded.");
    return;
  }
  if (needy.length === 0) {
    console.log("All funded. Nothing to do.");
    return;
  }
  if (!funder) {
    console.error("FUNDER_PRIVATE_KEY is required to top up (or pass --check to only report).");
    process.exit(1);
  }

  const funderBalance = balances.find((b) => b.label === "funder")!.balance;
  const needed = needy.reduce((sum, b) => sum + (TARGET - b.balance), 0n);
  if (funderBalance < needed) {
    console.error(
      `Funder holds ${mon(funderBalance)} but needs ${mon(needed)}. Top it up at the Monad faucet first.`,
    );
    process.exit(1);
  }

  const wallet = createWalletClient({ account: funder, chain, transport: http(RPC_URL) });
  for (const b of needy) {
    const value = TARGET - b.balance;
    // Explicit gas: Monad charges the declared limit, so an inflated estimate is a real cost.
    const hash = await wallet.sendTransaction({ to: b.address, value, gas: GAS.transfer });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  topped up ${b.label} (${b.address}) with ${mon(value)}  tx ${hash}`);
  }
  console.log("\nDone. Re-run with --check to confirm.\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
