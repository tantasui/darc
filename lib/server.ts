/**
 * The relayer, server-side.
 *
 * This is the ONE key that legitimately lives on a server: paying gas for someone else's
 * signed authorization is exactly a relayer's job, and it can only ever submit an
 * authorization the agent already signed. There is no server-held owner key any more — every
 * owner action is a passkey ceremony in the browser (see lib/mera.ts).
 */
import { createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, RPC_URL } from "@/config/chain";

export const chain = defineChain(MONAD_TESTNET);

function wallet(envKey: "RELAYER_PRIVATE_KEY") {
  const key = process.env[envKey] as Hex | undefined;
  if (!key) throw new Error(`${envKey} is not set. The demo routes need it; see .env.`);
  return createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC_URL) });
}

/** Submits agent-signed authorizations and pays their gas, including for declines. */
export const relayerWallet = () => wallet("RELAYER_PRIVATE_KEY");

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0];
  return String(err);
}
