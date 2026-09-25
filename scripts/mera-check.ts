/**
 * Mera de-risking check: PRF output -> BIP-39/BIP-32 -> secp256k1 EOA -> real transaction.
 *
 * Everything here EXCEPT the WebAuthn ceremony itself. The passkey ceremony needs a real
 * authenticator and a browser, so it lives in the browser page; this script proves every
 * other link in the chain headlessly and on-chain, so a failure in the browser can only be
 * the passkey step.
 *
 * NOTE ON DERIVATION: Mera does NOT derive keys. `createSecp256k1SigningSession` takes a
 * private key directly, so the PRF -> BIP-39 -> BIP-32 step is the application's job.
 *
 *   node scripts/mera-check.ts            # offline: derivation + signing only
 *   node scripts/mera-check.ts --onchain  # also funds the derived account and sends a tx
 */
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
// @scure/bip39 v2 requires the ".js" suffix on wordlist subpaths; without it Node throws
// ERR_PACKAGE_PATH_NOT_EXPORTED. Most guides still show the extensionless form.
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { createSecp256k1SigningSession, getEvmAddress } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { createPublicClient, createWalletClient, defineChain, http, formatEther, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, RPC_URL, GAS } from "../config/chain.ts";

/** BIP-44 EVM account 0, as specified. */
export const DERIVATION_PATH = "m/44'/60'/0'/0/0";

/** PRF output (32 bytes) -> mnemonic -> seed -> private key. The passkey is the root. */
export function deriveFromPrfOutput(prfOutput: Uint8Array) {
  if (prfOutput.length !== 32) throw new Error(`PRF output must be 32 bytes, got ${prfOutput.length}`);
  const mnemonic = entropyToMnemonic(prfOutput, wordlist);
  const hd = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(DERIVATION_PATH);
  if (!hd.privateKey) throw new Error("derivation produced no private key");
  return { mnemonic, privateKey: hd.privateKey };
}

const chain = defineChain(MONAD_TESTNET);
/** Fixed stand-in for a real PRF output so this check is reproducible. */
const FAKE_PRF = new Uint8Array(32).fill(7);

async function main() {
  console.log("\nMera chain check — PRF → EOA → transaction\n");

  const { mnemonic, privateKey } = deriveFromPrfOutput(FAKE_PRF);
  const session = createSecp256k1SigningSession({ privateKey });
  const account = toViemAccount(session);

  console.log(`  mnemonic         ${mnemonic.split(" ").length} words (never shown to users)`);
  console.log(`  derivation path  ${DERIVATION_PATH}`);
  console.log(`  address          ${account.address}`);
  console.log(`  source           ${account.source}`);
  console.log(`  address agrees   ${getEvmAddress(session.publicKey) === account.address}`);

  // Determinism is the whole recovery story: same passkey, same account, any device.
  const repeat = toViemAccount(createSecp256k1SigningSession({ privateKey: deriveFromPrfOutput(FAKE_PRF).privateKey }));
  console.log(`  deterministic    ${repeat.address === account.address}`);

  // The two signatures AgentCard actually needs.
  console.log(`  EIP-191 sig      ${(await account.signMessage({ message: "agentcard" })).length} chars`);
  console.log(
    `  EIP-712 sig      ${
      (await account.signTypedData({
        domain: { name: "AgentCard", version: "1", chainId: chain.id },
        types: { Probe: [{ name: "x", type: "uint256" }] },
        primaryType: "Probe",
        message: { x: 1n },
      })).length
    } chars`,
  );

  if (process.argv.includes("--onchain")) {
    const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
    const funderKey = process.env.FUNDER_PRIVATE_KEY as `0x${string}` | undefined;
    if (!funderKey) throw new Error("FUNDER_PRIVATE_KEY required for --onchain");

    let balance = await publicClient.getBalance({ address: account.address });
    if (balance < parseEther("0.02")) {
      const funder = createWalletClient({ account: privateKeyToAccount(funderKey), chain, transport: http(RPC_URL) });
      const fundTx = await funder.sendTransaction({ to: account.address, value: parseEther("0.05"), gas: GAS.transfer });
      await publicClient.waitForTransactionReceipt({ hash: fundTx });
      balance = await publicClient.getBalance({ address: account.address });
      console.log(`\n  funded derived account with 0.05 MON`);
    }
    console.log(`  balance          ${formatEther(balance)} MON`);

    // The real test: a transaction signed by the passkey-derived key, accepted by Monad.
    const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) });
    const hash = await wallet.sendTransaction({ to: account.address, value: 0n, gas: GAS.transfer });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`\n  TRANSACTION ${receipt.status === "success" ? "CONFIRMED" : "FAILED"} in block ${receipt.blockNumber}`);
    console.log(`  ${MONAD_TESTNET.blockExplorers.default.url}/tx/${hash}`);
    console.log(`  sender matches derived account: ${receipt.from.toLowerCase() === account.address.toLowerCase()}`);
  }

  // Prompt-per-transaction hygiene: the key must not outlive the session.
  session.end();
  try {
    await account.signMessage({ message: "after end" });
    console.log("\n  WARNING: signing still worked after session.end()");
  } catch (err) {
    console.log(`\n  after session.end()  ${(err as { code?: string }).code ?? "threw"} (key no longer usable)`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
