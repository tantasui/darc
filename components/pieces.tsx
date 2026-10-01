"use client";

/** Composed pieces built from the primitives, shared by more than one screen. */
import type { ReactNode } from "react";
import { merchantByAddress, merchantName } from "@/config/merchants";
import { addressUrl } from "@/lib/chain";
import { ExternalIcon } from "./icons";
import p from "./pieces.module.css";

const tintClass = (i?: number) => (i === 0 ? p.tint0 : i === 1 ? p.tint1 : i === 2 ? p.tint2 : p.tintNone);

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className={p.stat}>
      <div className={p.statLabel}>{label}</div>
      <div className={p.statValue}>{value}</div>
      {note && <div className={p.statNote}>{note}</div>}
    </div>
  );
}

export function MerchantCell({ address }: { address?: string }) {
  const m = merchantByAddress(address);
  return (
    <span className={p.merchantCell}>
      <span className={`${p.avatarSm} ${tintClass(m?.tintIndex)}`}>{m?.initials ?? "?"}</span>
      <span className={p.min0}>
        <span className={p.merchantName}>{merchantName(address)}</span>
        {m && <span className={p.merchantSellsBlock}>{m.sells}</span>}
      </span>
    </span>
  );
}

export function AddressLink({ address, label }: { address: string; label?: string }) {
  return (
    <a href={addressUrl(address)} target="_blank" rel="noreferrer" className={p.addressLink}>
      <span className={p.monoText}>{label ?? `${address.slice(0, 8)}…${address.slice(-6)}`}</span>
      <ExternalIcon />
    </a>
  );
}

export { p as pieces, tintClass };
