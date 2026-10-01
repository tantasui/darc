/**
 * The card list — a local cache over an on-chain source of truth.
 *
 * CardManager keys cards by keccak(owner, agentKey) and has no owner index, and public Monad
 * RPCs cap `eth_getLogs` at 100 blocks, so there is no way to ASK the chain "which cards are
 * mine". `discoverCards` solves that without a backend: agent keys are derived from the
 * passkey at a hardened path (see lib/mera.ts), so any device can recompute agent address
 * i = 0, 1, 2…, derive each cardId, and read it back with plain `eth_call`. Sign in on a new
 * device and your cards reappear.
 *
 * This file caches what discovery found so the agent can run without a passkey prompt per
 * action. The chain remains authoritative for every piece of card STATE.
 *
 * The agent private key is cached here too. That is demo-only custody, survivable only
 * because the key is capped, merchant-scoped, expiring and instantly revocable.
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const KEY = "agentcard.cards.v1";

export type StoredCard = {
  cardId: Hex;
  /** Index on the agent derivation branch, so the key can be recovered from the passkey. */
  index: number;
  owner: Address;
  agentAddress: Address;
  agentPrivateKey: Hex;
  agentName: string;
  persona: string;
  merchants: Address[];
  dailyCapUsd: number;
  issuedAt: number;
};

function read(): StoredCard[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredCard[]) : [];
  } catch {
    return [];
  }
}

function write(cards: StoredCard[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(cards));
  } catch {
    /* private mode: the card still exists on-chain, it just will not be listed here */
  }
}

export const listCards = (owner?: Address): StoredCard[] =>
  read().filter((c) => !owner || c.owner.toLowerCase() === owner.toLowerCase());

export const getCard = (cardId: string): StoredCard | undefined =>
  read().find((c) => c.cardId.toLowerCase() === cardId.toLowerCase());

export function saveCard(card: StoredCard) {
  const rest = read().filter((c) => c.cardId.toLowerCase() !== card.cardId.toLowerCase());
  write([card, ...rest]);
}

/** Last four of the agent address — what the card's masked number shows. */
export const last4 = (agentAddress: string) => agentAddress.slice(-4).toUpperCase();

/* ---------- attempt log ---------------------------------------------------- */

/**
 * Amounts and timestamps for each attempt. The ON-CHAIN record of what happened lives in the
 * ERC-8004 attestations (verdict + reason, written by the merchant); those carry no amount or
 * timestamp, because the registry stores only two tag strings per entry. This log fills in
 * those two columns for attempts made from this browser, and is clearly labelled as such in
 * the UI. It is never the source of truth for whether something was approved.
 */
const LOG_KEY = "agentcard.attempts.v1";

export type Attempt = {
  id: string;
  cardId: Hex;
  agentAddress: Address;
  agentName: string;
  merchant: Address;
  amountUsd: number;
  ok: boolean;
  reason: string | null;
  hash?: Hex;
  at: number;
  task?: string;
};

export function listAttempts(cardId?: string): Attempt[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const all = raw ? (JSON.parse(raw) as Attempt[]) : [];
    const filtered = cardId ? all.filter((a) => a.cardId.toLowerCase() === cardId.toLowerCase()) : all;
    return filtered.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export function saveAttempt(attempt: Attempt) {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const all = raw ? (JSON.parse(raw) as Attempt[]) : [];
    localStorage.setItem(LOG_KEY, JSON.stringify([attempt, ...all].slice(0, 300)));
  } catch {
    /* ignore */
  }
}


/* ---------- on-chain discovery --------------------------------------------- */

/** cardId as CardManager computes it: keccak256(abi.encode(owner, agentKey)). */
export function cardIdFor(owner: Address, agentKey: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }], [owner, agentKey]));
}

/**
 * Walks the agent derivation branch and asks the chain about each candidate card.
 *
 * Stops after `gap` consecutive misses, the same convention wallets use for address
 * discovery — issuance is sequential, so a run of empties means the end of the list.
 */
export async function discoverCards(
  owner: Address,
  deriveAgentKey: (index: number) => Hex,
  exists: (cardId: Hex) => Promise<boolean>,
  opts: { gap?: number; max?: number } = {},
): Promise<StoredCard[]> {
  const gap = opts.gap ?? 4;
  const max = opts.max ?? 40;
  const found: StoredCard[] = [];
  let misses = 0;

  for (let index = 0; index < max && misses < gap; index++) {
    const agentPrivateKey = deriveAgentKey(index);
    const agentAddress = privateKeyToAccount(agentPrivateKey).address;
    const cardId = cardIdFor(owner, agentAddress);

    if (!(await exists(cardId))) {
      misses++;
      continue;
    }
    misses = 0;

    // Keep whatever the issuing device recorded (limit, merchant list, names); fall back to
    // sensible values when recovering on a device that has never seen this card.
    const cached = getCard(cardId);
    found.push({
      cardId,
      index,
      owner,
      agentAddress,
      agentPrivateKey,
      agentName: cached?.agentName ?? "Atlas",
      persona: cached?.persona ?? "Procurement assistant",
      merchants: cached?.merchants ?? [],
      dailyCapUsd: cached?.dailyCapUsd ?? 0,
      issuedAt: cached?.issuedAt ?? Date.now(),
    });
  }

  for (const card of found) saveCard(card);
  return found;
}

/** Next free index on the agent branch, so issuance stays sequential and discoverable. */
export function nextIndex(owner?: Address): number {
  const mine = listCards(owner);
  return mine.length === 0 ? 0 : Math.max(...mine.map((c) => c.index ?? 0)) + 1;
}
