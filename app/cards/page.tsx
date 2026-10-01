"use client";

/** Cards — every issued card as an actual card, plus the issue flow. */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { Address } from "viem";
import { Shell } from "@/components/shell";
import { Button, Empty, Notice, Panel, ui as u } from "@/components/ui";
import { AgentCardFace } from "@/components/agent-card";
import { pieces as p, tintClass } from "@/components/pieces";
import { PlusIcon } from "@/components/icons";
import { MERCHANTS } from "@/config/merchants";
import { ADDRESSES, ausdFaucetAbi, cardManagerAbi, erc20Abi } from "@/lib/contracts";
import { merchantRoot } from "@/lib/merkle";
import { AGENT } from "@/lib/agent";
import { last4, listCards, saveCard, type StoredCard } from "@/lib/cards";
import { chain, fmtUsd, loadCardState, loadOwnerFunds, publicClient, type CardState } from "@/lib/chain";
import { useOwner } from "@/lib/owner-context";

const APPROVAL = 500_000_000n;

export default function CardsPage() {
  const { owner, busy, error, signIn, runOwnerAction } = useOwner();
  const [cards, setCards] = useState<{ stored: StoredCard; state: CardState | null }[]>([]);
  const [issuing, setIssuing] = useState(false);
  const [cap, setCap] = useState(50);
  const [picked, setPicked] = useState<Address[]>([MERCHANTS[0].address, MERCHANTS[1].address]);
  const [funds, setFunds] = useState<{ mon: bigint; usd: bigint; allowance: bigint }>();
  const [justIssued, setJustIssued] = useState<string>();

  const load = useCallback(async () => {
    const stored = listCards(owner);
    setCards(await Promise.all(stored.map(async (s) => ({ stored: s, state: await loadCardState(s.cardId).catch(() => null) }))));
    if (owner) setFunds(await loadOwnerFunds(owner).catch(() => undefined));
  }, [owner]);

  useEffect(() => {
    void load();
  }, [load]);

  const needsFunding = funds ? funds.usd < 100_000_000n || funds.allowance < APPROVAL : false;

  const prepare = () =>
    runOwnerAction("Preparing your account", async (wallet, address) => {
      const account = wallet.account!;
      // AUSD is a real token, so there is no mint: claim from Agora's public testnet faucet.
      if ((funds?.usd ?? 0n) < 100_000_000n) {
        const hash = await wallet.writeContract({
          address: ADDRESSES.ausdFaucet,
          abi: ausdFaucetAbi,
          functionName: "requestFunds",
          args: [address],
          account,
          chain,
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }
      const current = await publicClient.readContract({
        address: ADDRESSES.paymentToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, ADDRESSES.spendGate],
      });
      if (current < APPROVAL) {
        const hash = await wallet.writeContract({
          address: ADDRESSES.paymentToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [ADDRESSES.spendGate, APPROVAL],
          account,
          chain,
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }
      await load();
    });

  const issue = () =>
    runOwnerAction("Issuing the card", async (wallet, address) => {
      // Fresh, random, per card — never derived from the passkey, so it is independently
      // revocable and disposable.
      const agentPrivateKey = generatePrivateKey();
      const agentAddress = privateKeyToAccount(agentPrivateKey).address;
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);

      const hash = await wallet.writeContract({
        address: ADDRESSES.cardManager,
        abi: cardManagerAbi,
        functionName: "issueCard",
        args: [agentAddress, BigInt(cap) * 1_000_000n, merchantRoot(picked), validUntil, "ipfs://agentcard"],
        account: wallet.account!,
        chain,
      });
      await publicClient.waitForTransactionReceipt({ hash });

      const cardId = await publicClient.readContract({
        address: ADDRESSES.cardManager,
        abi: cardManagerAbi,
        functionName: "cardIdFor",
        args: [address, agentAddress],
      });

      saveCard({
        cardId,
        owner: address,
        agentAddress,
        agentPrivateKey,
        agentName: AGENT.name,
        persona: AGENT.persona,
        merchants: picked,
        dailyCapUsd: cap,
        issuedAt: Date.now(),
      });
      setIssuing(false);
      setJustIssued(cardId);
      await load();
    });

  if (!owner) {
    return (
      <Shell title="Cards" subtitle="Sign in to issue and manage cards.">
        <Panel>
          <Empty title="Not signed in">
            <Button variant="primary" onClick={() => signIn("signIn")} disabled={!!busy}>
              {busy ?? "Sign in with your passkey"}
            </Button>
          </Empty>
        </Panel>
      </Shell>
    );
  }

  return (
    <Shell
      title="Cards"
      subtitle="Each card authorises one agent key, under limits you set, until you revoke it."
      action={
        !issuing && !needsFunding ? (
          <Button variant="primary" onClick={() => setIssuing(true)}>
            <PlusIcon /> Issue a card
          </Button>
        ) : undefined
      }
    >
      <div className={p.stack}>
        {error && (
          <Notice tone="error" title="That did not go through">
            {error}
          </Notice>
        )}

        {needsFunding && (
          <Panel title="One-time setup">
            <p className={u.lead}>
              Cards settle in <strong>AUSD</strong>, a real dollar stablecoin on Monad Testnet — not
              a token we minted. Claim some from the public faucet and approve a spending limit for
              AgentCard. The approval is bounded at {fmtUsd(APPROVAL)} on purpose: an unlimited one
              would sit above every card&apos;s limit.
            </p>
            <Button variant="primary" onClick={prepare} disabled={!!busy}>
              {busy ?? "Claim AUSD and approve"}
            </Button>
          </Panel>
        )}

        {issuing && (
          <Panel title="New card">
            <label className={p.field}>
              <span className={p.fieldLabel}>
                <span>Daily limit</span>
                <strong>${cap}</strong>
              </span>
              <input type="range" min={10} max={200} step={10} value={cap} onChange={(e) => setCap(Number(e.target.value))} className={u.fullRange} />
            </label>

            <div className={p.field}>
              <span className={p.fieldLabel}>
                <span>Allowed merchants</span>
                <span className={u.dim}>{picked.length === 0 ? "any merchant" : `${picked.length} selected`}</span>
              </span>
              {MERCHANTS.map((m) => {
                const on = picked.includes(m.address);
                return (
                  <label key={m.address} className={`${p.check} ${on ? p.checkOn : ""}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => setPicked((prev) => (e.target.checked ? [...prev, m.address] : prev.filter((x) => x !== m.address)))}
                    />
                    <span className={`${p.avatarSm} ${tintClass(m.tintIndex)}`}>{m.initials}</span>
                    <span>
                      <span className={u.strong}>{m.name}</span>
                      <span className={p.merchantSellsBlock}>{m.sells}</span>
                    </span>
                  </label>
                );
              })}
            </div>

            <div className={p.btnRow}>
              <Button variant="primary" onClick={issue} disabled={!!busy}>
                {busy ?? `Issue to ${AGENT.name}`}
              </Button>
              <Button variant="ghost" onClick={() => setIssuing(false)} disabled={!!busy}>
                Cancel
              </Button>
            </div>
          </Panel>
        )}

        {cards.length === 0 && !issuing ? (
          <Panel>
            <Empty title="No cards yet">
              <p className={u.narrow}>
                {AGENT.name} is a {AGENT.persona.toLowerCase()}. {AGENT.brief}
              </p>
              {!needsFunding && (
                <Button variant="primary" onClick={() => setIssuing(true)}>
                  Issue the first card
                </Button>
              )}
            </Empty>
          </Panel>
        ) : (
          <div className={p.cardGrid}>
            {cards.map(({ stored, state }) => (
              <Link
                key={stored.cardId}
                href={`/cards/${stored.cardId}`}
                className={`${p.cardLink} ${justIssued === stored.cardId ? u.reveal : ""}`}
              >
                <AgentCardFace
                  last4={last4(stored.agentAddress)}
                  agentName={stored.agentName}
                  persona={stored.persona}
                  dailyCap={state?.dailyCap ?? BigInt(stored.dailyCapUsd) * 1_000_000n}
                  remaining={state?.remaining}
                  revoked={state?.revoked ?? false}
                  expired={state?.expired}
                  merchantCount={stored.merchants.length}
                />
              </Link>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}
