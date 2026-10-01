/**
 * Merchant identities. The names are also stored on-chain in each MockMerchant (`name()`),
 * so these are labels for a real counterparty rather than UI decoration.
 *
 * They are the kinds of things an AI agent actually buys: compute, API access, subscriptions.
 */
import { ADDRESSES } from "./addresses";

export type Merchant = {
  address: `0x${string}`;
  name: string;
  initials: string;
  sells: string;
  /** Index into the tint classes in components/pieces.module.css. */
  tintIndex: 0 | 1 | 2;
};

export const MERCHANTS: Merchant[] = [
  {
    address: ADDRESSES.mockMerchantA,
    name: "Lagos Cloud Hosting",
    initials: "LC",
    sells: "Compute & hosting",
    tintIndex: 0,
  },
  {
    address: ADDRESSES.mockMerchantB,
    name: "Horizon Data API",
    initials: "HD",
    sells: "API access",
    tintIndex: 1,
  },
  {
    address: ADDRESSES.mockMerchantC,
    name: "Riverside Subscriptions",
    initials: "RS",
    sells: "Recurring subscriptions",
    tintIndex: 2,
  },
];

export const merchantByAddress = (address?: string): Merchant | undefined =>
  address ? MERCHANTS.find((m) => m.address.toLowerCase() === address.toLowerCase()) : undefined;

export const merchantName = (address?: string): string =>
  merchantByAddress(address)?.name ?? (address ? `${address.slice(0, 8)}…` : "Unknown");
