/**
 * Server-side wallets for the demo surface.
 *
 * DEMO ONLY, AND DELIBERATELY SO. These routes hold the owner and relayer keys server-side
 * and are unauthenticated: anyone who can reach them can issue or revoke a card on the demo
 * owner's behalf. That is acceptable here because both keys are throwaway testnet keys
 * holding testnet MON and a mock token, and because it keeps the demo clickable without a
 * passkey prompt on every step.
 *
 * It is NOT the product. In the real flow the owner's key is derived from a passkey in the
 * browser and never exists on a server (see lib/mera.ts). The relayer is the only part that
 * legitimately stays server-side, because paying gas for someone else's signed authorization
 * is exactly its job.
 */
import { createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, RPC_URL } from "@/config/chain";

export const chain = defineChain(MONAD_TESTNET);

function wallet(envKey: "OWNER_PRIVATE_KEY" | "RELAYER_PRIVATE_KEY") {
  const key = process.env[envKey] as Hex | undefined;
  if (!key) throw new Error(`${envKey} is not set. The demo routes need it; see .env.`);
  return createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC_URL) });
}

/** Stands in for the passkey-derived owner until the console is wired to Mera. */
export const ownerWallet = () => wallet("OWNER_PRIVATE_KEY");

/** Submits agent-signed authorizations and pays their gas, including for declines. */
export const relayerWallet = () => wallet("RELAYER_PRIVATE_KEY");

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0];
  return String(err);
}
