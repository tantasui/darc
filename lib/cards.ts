/**
 * The browser's record of cards issued from this device.
 *
 * WHY LOCAL: CardManager keys cards by keccak(owner, agentKey) and the ERC-8004 registry has
 * no owner index, so there is no on-chain way to enumerate "my cards" — and public Monad RPCs
 * cap `eth_getLogs` at 100 blocks, so scanning CardIssued events is not an option either.
 * This file therefore remembers which cards this browser issued; every piece of card STATE
 * (limit, remaining, revoked) is still read from the chain, which stays the source of truth.
 *
 * The agent private key is stored here too. That is demo-only custody, and it is survivable
 * only because the key is capped, merchant-scoped, expiring and instantly revocable.
 */
import type { Address, Hex } from "viem";

const KEY = "agentcard.cards.v1";

export type StoredCard = {
  cardId: Hex;
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
