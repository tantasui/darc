"use client";

/** Agents — the ERC-8004 identity side: who holds a card, and what their record says. */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Shell } from "@/components/shell";
import { Button, DataRow, Empty, Panel, StatusBadge, Table, ui as u } from "@/components/ui";
import { AddressLink, pieces as p } from "@/components/pieces";
import { listCards, type StoredCard } from "@/lib/cards";
import { loadAgentReport, loadCardState, loadIdentity } from "@/lib/chain";
import { useOwner } from "@/lib/owner-context";

type AgentRow = {
  card: StoredCard;
  agentId?: string;
  approved: number;
  declined: number;
  revoked: boolean;
  expired: boolean;
  holder?: string;
  wallet?: string;
};

export default function AgentsPage() {
  const { owner } = useOwner();
  const [rows, setRows] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const cards = listCards(owner);
    const out = await Promise.all(
      cards.map(async (card) => {
        const [report, state] = await Promise.all([
          loadAgentReport(card.agentAddress).catch(() => undefined),
          loadCardState(card.cardId).catch(() => null),
        ]);
        const identity = state ? await loadIdentity(state.agentId).catch(() => ({ holder: undefined, wallet: undefined })) : undefined;
        return {
          card,
          agentId: state?.agentId,
          approved: Number(report?.approvedCount ?? 0),
          declined: Number(report?.declinedCount ?? 0),
          revoked: Boolean(report?.revoked ?? state?.revoked),
          expired: Boolean(report?.expired ?? state?.expired),
          holder: identity?.holder as string | undefined,
          wallet: identity?.wallet as string | undefined,
        };
      }),
    );
    setRows(out);
    setLoading(false);
  }, [owner]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Shell
      title="Agents"
      subtitle="Each agent has an ERC-8004 identity on the shared registry, so its record follows it rather than living only in our database."
    >
      <div className={p.stack}>
        <Panel flush>
          {loading ? (
            <Empty title="Reading the registry…" />
          ) : rows.length === 0 ? (
            <Empty title="No agents yet">
              <Link href="/cards">
                <Button variant="primary">Issue a card</Button>
              </Link>
            </Empty>
          ) : (
            <Table head={["Agent", "Identity", "Approved", "Refused", "Standing"]}>
              {rows.map((r) => (
                <tr key={r.card.cardId}>
                  <td>
                    <Link href={`/cards/${r.card.cardId}`} className={u.linkStrong}>
                      {r.card.agentName}
                    </Link>
                    <div className={u.sub}>{r.card.persona}</div>
                  </td>
                  <td>{r.agentId ? `#${r.agentId}` : "—"}</td>
                  <td className={u.cellMonoOk}>{r.approved}</td>
                  <td className={u.cellMonoDanger}>{r.declined}</td>
                  <td>
                    {r.revoked ? (
                      <StatusBadge kind="revoked" />
                    ) : r.expired ? (
                      <StatusBadge kind="expired" />
                    ) : (
                      <StatusBadge kind="active" />
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>

        {rows.map((r) => (
          <Panel key={`${r.card.cardId}-detail`} title={`${r.card.agentName} — identity`}>
            <DataRow label="Agent key" value={<AddressLink address={r.card.agentAddress} />} />
            <DataRow label="ERC-8004 id" value={r.agentId ? `#${r.agentId}` : "—"} />
            <DataRow label="Identity held by" value={r.holder ? <AddressLink address={r.holder} /> : "—"} />
            <DataRow label="agentWallet" value={r.wallet ? <AddressLink address={r.wallet} /> : "—"} />
            <DataRow
              label="Anyone can check this"
              value={<Link href={`/verify?agent=${r.card.agentAddress}`}>Open in the public verifier</Link>}
            />
          </Panel>
        ))}
      </div>
    </Shell>
  );
}
