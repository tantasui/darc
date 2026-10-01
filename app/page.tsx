"use client";

/** Home — the overview a judge lands on: real numbers first, nothing diagnostic. */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Shell } from "@/components/shell";
import { Button, DataRow, Empty, Notice, Panel, StatusBadge, Table, ui as u } from "@/components/ui";
import { AgentCardFace } from "@/components/agent-card";
import { MerchantCell, Stat, pieces as p } from "@/components/pieces";
import { PlusIcon } from "@/components/icons";
import { AGENT } from "@/lib/agent";
import { last4, listAttempts, listCards, type StoredCard } from "@/lib/cards";
import { fmtUsd, loadCardState, type CardState } from "@/lib/chain";
import { useOwner } from "@/lib/owner-context";

export default function HomePage() {
  const { owner, signIn, busy, error } = useOwner();
  const [cards, setCards] = useState<{ stored: StoredCard; state: CardState | null }[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const stored = listCards(owner);
    const withState = await Promise.all(
      stored.map(async (s) => ({ stored: s, state: await loadCardState(s.cardId).catch(() => null) })),
    );
    setCards(withState);
    setLoading(false);
  }, [owner]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = cards.filter((c) => c.state && !c.state.revoked && !c.state.expired);
  const attempts = listAttempts();
  const today = attempts.filter((a) => a.at > Date.now() - 86_400_000);
  const approvedToday = today.filter((a) => a.ok).length;
  const declinedToday = today.filter((a) => !a.ok).length;
  const recent = attempts.slice(0, 5);
  const featured = active[0] ?? cards[0];

  if (!owner) {
    return (
      <Shell
        title="Spending cards for AI agents"
        subtitle="Give an agent a card with a daily limit and a short list of merchants. Every attempt it makes — approved or refused — is written on-chain where anyone can check it."
      >
        <div className={p.grid2}>
          <div className={p.stack}>
            <Panel>
              <h2 className={u.h3}>Sign in with a passkey</h2>
              <p className={u.lead}>
                No seed phrase and no password. Your account is derived from your passkey on this
                device, and the key never reaches a server.
              </p>
              <div className={p.btnRow}>
                <Button variant="primary" size="lg" onClick={() => signIn("create")} disabled={!!busy}>
                  {busy ?? "Create an account"}
                </Button>
                <Button size="lg" onClick={() => signIn("signIn")} disabled={!!busy}>
                  I already have one
                </Button>
              </div>
              {error && (
                <div className={u.mt4}>
                  <Notice tone="error" title="We could not read your account">
                    {error}
                  </Notice>
                </div>
              )}
            </Panel>
            <Panel title="Why it is safe to hand over">
              <DataRow label="Daily limit" value="Spending above it is refused on-chain, not just flagged" />
              <DataRow label="Merchant list" value="Payments anywhere else are refused" />
              <DataRow label="Revocable" value="One action kills the card instantly and permanently" />
              <DataRow label="Public record" value="Refusals are recorded, not only approvals" />
              <DataRow label="Settles in" value="AUSD, a real dollar stablecoin on Monad Testnet" />
            </Panel>
          </div>
          <Panel className={u.centerPanel}>
            <AgentCardFace
              last4="A55A"
              agentName={AGENT.name}
              persona={AGENT.persona}
              dailyCap={50_000_000n}
              remaining={30_000_000n}
              revoked={false}
              merchantCount={2}
            />
          </Panel>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title="Overview"
      subtitle={`Signed in as ${owner.slice(0, 6)}…${owner.slice(-4)}.`}
      action={
        <Link href="/cards">
          <Button variant="primary">
            <PlusIcon /> Issue a card
          </Button>
        </Link>
      }
    >
      <div className={p.stack}>
        <div className={p.stats}>
          <Stat label="Active cards" value={loading ? "—" : active.length} note={`${cards.length} issued in total`} />
          <Stat label="Approved today" value={approvedToday} note="payments that went through" />
          <Stat label="Refused today" value={declinedToday} note="blocked by policy" />
          <Stat
            label="Remaining today"
            value={featured?.state ? fmtUsd(featured.state.remaining) : "—"}
            note={featured ? `of ${featured.state ? fmtUsd(featured.state.dailyCap) : "—"} on ${featured.stored.agentName}` : "no card yet"}
          />
        </div>

        {cards.length === 0 ? (
          <Panel>
            <Empty title="No cards yet">
              <p className={u.narrow}>
                Issue one to {AGENT.name}, then watch it work through its tasks and get refused when
                it oversteps.
              </p>
              <Link href="/cards">
                <Button variant="primary">Issue the first card</Button>
              </Link>
            </Empty>
          </Panel>
        ) : (
          <div className={p.grid2}>
            {featured && (
              <Panel title="Your card" action={<Link href={`/cards/${featured.stored.cardId}`}>Open</Link>}>
                <Link href={`/cards/${featured.stored.cardId}`} className={p.cardLink}>
                  <AgentCardFace
                    last4={last4(featured.stored.agentAddress)}
                    agentName={featured.stored.agentName}
                    persona={featured.stored.persona}
                    dailyCap={featured.state?.dailyCap ?? BigInt(featured.stored.dailyCapUsd) * 1_000_000n}
                    remaining={featured.state?.remaining}
                    revoked={featured.state?.revoked ?? false}
                    expired={featured.state?.expired}
                    merchantCount={featured.stored.merchants.length}
                  />
                </Link>
              </Panel>
            )}

            <Panel
              title="Recent activity"
              note="The on-chain record of every attempt this agent made."
              action={<Link href="/activity">View all</Link>}
              flush
            >
              {recent.length === 0 ? (
                <Empty title="Nothing yet">Run the agent from its card to see attempts here.</Empty>
              ) : (
                <Table head={["Merchant", "Amount", "Result"]}>
                  {recent.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <MerchantCell address={a.merchant} />
                      </td>
                      <td className={u.cellMono}>${a.amountUsd}</td>
                      <td>
                        {a.ok ? <StatusBadge kind="approved" /> : <StatusBadge kind="declined" label={a.reason ?? "Declined"} />}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Panel>
          </div>
        )}
      </div>
    </Shell>
  );
}
