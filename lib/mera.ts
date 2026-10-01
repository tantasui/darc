/**
 * Passkey -> EOA derivation, shared by the console and the Mera check page.
 *
 * Mera does NOT derive keys: `createSecp256k1SigningSession` takes a private key, so the
 * PRF -> BIP-39 -> BIP-32 step below is ours. Nor does it verify anything on-chain -- the
 * result is a plain secp256k1 EOA. The passkey is the derivation root and the recovery
 * mechanism, not an on-chain signer.
 */
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
// @scure/bip39 v2 needs the ".js" suffix here; the extensionless form most guides show
// throws ERR_PACKAGE_PATH_NOT_EXPORTED.
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
  isMeraError,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { toHex, type Hex, type LocalAccount } from "viem";

/** BIP-44 EVM account 0 — the owner's own account. */
export const DERIVATION_PATH = "m/44'/60'/0'/0/0";

/**
 * Agent keys live on a separate, HARDENED branch: BIP-44 account 1, hardened all the way to
 * the leaf.
 *
 * WHY DERIVED RATHER THAN RANDOM. Random agent keys cannot be recovered, and because
 * CardManager keys cards by keccak(owner, agentKey) with no owner index — and public Monad
 * RPCs cap `eth_getLogs` at 100 blocks — a random key means a card is only findable on the
 * device that issued it. Deriving the key makes the whole card list recoverable from the
 * passkey alone, on any device, with nothing but `eth_call`.
 *
 * WHY THIS IS STILL SAFE. The branch is hardened, so a leaked agent private key yields
 * neither its siblings nor anything about its parent: one compromised agent stays one
 * compromised agent. And the passkey already derives the OWNER key, which can issue and
 * revoke cards outright — so an attacker holding the PRF output was never limited by agent
 * keys being random. What changes is the narrative, not the blast radius: agent keys are now
 * passkey-rooted. They remain independently revocable, which is the property that matters,
 * because revocation is on-chain policy and has nothing to do with how a key was made.
 */
export const agentPath = (index: number) => `m/44'/60'/1'/0'/${index}'`;

const STORAGE_KEY = "agentcard.passkey";

/** Metadata only -- never key material. The PRF output is the wallet; it is never stored. */
export type StoredCredential = { credentialId: string; transports?: readonly string[] };

export function loadCredential(): StoredCredential | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredCredential) : null;
  } catch {
    return null;
  }
}

export function saveCredential(c: StoredCredential) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* private mode: the passkey still works, it just will not be pre-selected next visit */
  }
}

export function clearCredential() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

function masterFromPrf(prfOutput: Uint8Array): HDKey {
  if (prfOutput.length !== 32) throw new Error(`PRF output must be 32 bytes, got ${prfOutput.length}`);
  return HDKey.fromMasterSeed(mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist)));
}

function privateKeyAt(master: HDKey, path: string): Uint8Array {
  const hd = master.derive(path);
  if (!hd.privateKey) throw new Error("derivation produced no private key");
  return hd.privateKey;
}

/**
 * Runs one passkey ceremony and returns a short-lived signing session.
 *
 * PROMPT-PER-TRANSACTION: callers must `session.end()` in a `finally` block. Owner actions
 * are rare and high-stakes, so one biometric prompt each is a feature, and the key should
 * never outlive the action it authorized.
 */
export async function openOwnerSession(
  mode: "create" | "signIn",
  rpId: string,
): Promise<{
  account: LocalAccount;
  end: () => void;
  credentialId: string;
  /** Agent key for a card index. Valid only until `end()`. */
  deriveAgentKey: (index: number) => Hex;
}> {
  let prfOutput: Uint8Array;
  let credentialId: string;

  if (mode === "create") {
    const created = await createPasskeyWithPrfOutput({
      rp: { id: rpId, name: "AgentCard" },
      user: { name: "AgentCard owner", displayName: "AgentCard owner" },
    });
    prfOutput = created.prfOutput;
    credentialId = created.credentialId;
    saveCredential({ credentialId: created.credentialId, transports: created.transports });
  } else {
    const stored = loadCredential();
    const got = await getPasskeyPrfOutput({
      rpId,
      // Omitted credential => the platform offers any discoverable passkey for this domain.
      credential: stored ? { credentialId: stored.credentialId, transports: stored.transports } : undefined,
    } as Parameters<typeof getPasskeyPrfOutput>[0]);
    prfOutput = got.prfOutput;
    credentialId = got.credentialId;
    saveCredential({ credentialId: got.credentialId, transports: stored?.transports });
  }

  const master = masterFromPrf(prfOutput);
  // Wipe the PRF output: it is equivalent to the seed phrase.
  prfOutput.fill(0);

  const privateKey = privateKeyAt(master, DERIVATION_PATH);
  const session = createSecp256k1SigningSession({ privateKey });
  privateKey.fill(0);

  return {
    account: toViemAccount(session),
    credentialId,
    deriveAgentKey: (index: number) => toHex(privateKeyAt(master, agentPath(index))),
    end: () => {
      session.end();
      // The master must not outlive the action either, or prompt-per-transaction is a fiction.
      master.wipePrivateData();
    },
  };
}

/** Turns Mera's error codes into something a user can act on. */
export function explainError(err: unknown): string {
  if (isMeraError(err)) {
    switch (err.code) {
      case "PRF_UNAVAILABLE":
        return "This passkey provider does not support the WebAuthn PRF extension, which AgentCard needs to derive your account. Desktop Chrome passkeys saved to the local profile are the usual cause. Use iCloud Keychain, 1Password, or Google Password Manager instead.";
      case "PASSKEY_OPERATION_FAILED":
        return "The passkey prompt was dismissed or failed. Try again.";
      case "CRYPTO_UNAVAILABLE":
        return "This page needs a secure context. Open it over HTTPS or on localhost.";
      case "SESSION_ENDED":
        return "That signing session has already ended. Start the action again.";
      case "INPUT_INVALID":
        return `Invalid input: ${err.message}`;
      default:
        return `${err.code}: ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
