"use client";

/**
 * Activity — the on-chain record, across every card.
 *
 * Each row exists in the ERC-8004 reputation registry, written by the merchant. The registry
 * stores only two tag strings per entry (verdict and reason), so amount and time come from
 * this browser's record of the attempt; the table says so rather than implying the chain
 * holds more than it does.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Shell } from "@/components/shell";
import { Button, Empty, Panel, StatusBadge, Table, ui as u } from "@/components/ui";
import { AddressLink, MerchantCell, pieces as p } from "@/components/pieces";
import { MERCHANTS } from "@/config/merchants";
import { listAttempts, listCards, type Attempt, type StoredCard } from "@/lib/cards";
import { loadAttestations, loadCardState, txUrl, type Attestation } from "@/lib/chain";
import { useOwner } from "@/lib/owner-context";

type Row = {
  key: string;
  card?: StoredCard;
  agentName: string;
  merchant: string;
  verdict: string;
  reason: string;
  amountUsd?: number;
  at?: number;
  hash?: string;
};

type Filter = "all" | "approved" | "declined";

export default function ActivityPage() {
  const { owner } = useOwner();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [merchantFilter, setMerchantFilter] = useState<string>("all");

  const load = useCallback(async () => {
    const cards = listCards(owner);
    const attempts = listAttempts();
    const out: Row[] = [];

    for (const card of cards) {
      const state = await loadCardState(card.cardId).catch(() => null);
      if (!state) continue;
      const attestations: Attestation[] = await loadAttestations(state.agentId).catch(() => []);
      const used = new Set<string>();

      for (const a of attestations) {
        // Pair each attestation with the local attempt that produced it, for amount and time.
        const match = attempts.find(
          (x: Attempt) =>
            x.cardId.toLowerCase() === card.cardId.toLowerCase() &&
            x.merchant.toLowerCase() === a.client.toLowerCase() &&
            x.ok === (a.verdict === "approved") &&
            (a.verdict === "approved" || x.reason === a.reason) &&
            !used.has(x.id),
        );
        if (match) used.add(match.id);
        out.push({
          key: `${card.cardId}-${a.client}-${a.index}`,
          card,
          agentName: card.agentName,
          merchant: a.client,
          verdict: a.verdict,
          reason: a.reason,
          amountUsd: match?.amountUsd,
          at: match?.at,
          hash: match?.hash,
        });
      }
    }

    out.sort((x, y) => (y.at ?? 0) - (x.at ?? 0));
    setRows(out);
    setLoading(false);
  }, [owner]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (filter === "all" || r.verdict === filter) &&
          (merchantFilter === "all" || r.merchant.toLowerCase() === merchantFilter.toLowerCase()),
      ),
    [rows, filter, merchantFilter],
  );

  const approved = rows.filter((r) => r.verdict === "approved").length;
  const declined = rows.length - approved;

  return (
    <Shell
      title="Activity"
      subtitle="Every attempt your agents made, as recorded on-chain. Refusals are kept alongside approvals — that is the part most systems throw away."
    >
      <div className={p.stack}>
        <div className={p.rowBetween}>
          <div className={p.btnRow}>
            {(["all", "approved", "declined"] as Filter[]).map((f) => (
              <Button key={f} variant={filter === f ? "primary" : "ghost"} onClick={() => setFilter(f)}>
                {f === "all" ? `All ${rows.length}` : f === "approved" ? `Approved ${approved}` : `Refused ${declined}`}
              </Button>
            ))}
          </div>
          <div className={p.btnRow}>
            <Button variant={merchantFilter === "all" ? "secondary" : "ghost"} onClick={() => setMerchantFilter("all")}>
              All merchants
            </Button>
            {MERCHANTS.map((m) => (
              <Button
                key={m.address}
                variant={merchantFilter === m.address ? "secondary" : "ghost"}
                onClick={() => setMerchantFilter(m.address)}
              >
                {m.initials}
              </Button>
            ))}
          </div>
        </div>

        <Panel flush>
          {loading ? (
            <Empty title="Reading the registry…" />
          ) : filtered.length === 0 ? (
            <Empty title={rows.length === 0 ? "No activity yet" : "Nothing matches that filter"}>
              {rows.length === 0 && (
                <Link href="/cards">
                  <Button variant="primary">Issue a card and run the agent</Button>
                </Link>
              )}
            </Empty>
          ) : (
            <Table head={["Agent", "Merchant", "Result", "Reason", "Amount", "When", "Tx"]}>
              {filtered.map((r) => (
                <tr key={r.key}>
                  <td>
                    {r.card ? (
                      <Link href={`/cards/${r.card.cardId}`} className={u.linkStrong}>
                        {r.agentName}
                      </Link>
                    ) : (
                      r.agentName
                    )}
                  </td>
                  <td>
                    <MerchantCell address={r.merchant} />
                  </td>
                  <td>
                    {r.verdict === "approved" ? <StatusBadge kind="approved" /> : <StatusBadge kind="declined" label="Refused" />}
                  </td>
                  <td className={r.verdict === "approved" ? u.dim : u.danger}>
                    {r.reason === "approved" ? "—" : r.reason}
                  </td>
                  <td className={u.cellMono}>{r.amountUsd !== undefined ? `$${r.amountUsd}` : "—"}</td>
                  <td className={u.dim}>{r.at ? new Date(r.at).toLocaleTimeString() : "—"}</td>
                  <td>{r.hash ? <a href={txUrl(r.hash)} target="_blank" rel="noreferrer">view</a> : <span className={u.dim}>—</span>}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        <Panel note="Verdicts and reasons come from the ERC-8004 reputation registry and were written by the merchants, not by us. Amounts and times come from this browser's record of each attempt, because the registry stores only the verdict and the reason.">
          <AddressLink address="0x8004B663056A597Dffe9eCcC1965A193B7388713" label="Reputation registry on Monad Testnet" />
        </Panel>
      </div>
    </Shell>
  );
}
