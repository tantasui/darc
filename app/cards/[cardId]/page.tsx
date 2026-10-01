"use client";

/**
 * Card detail — the card itself, its policy, and Atlas working through its goals beside it.
 *
 * The agent run is the point of this screen. It is not a row of buttons: the agent takes its
 * own goal list, chooses an amount and a merchant per goal, and reacts to each refusal
 * according to WHY it was refused (see lib/agent.ts). The transcript narrates its reasoning
 * so the behaviour is legible rather than implied.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Shell } from "@/components/shell";
import { Button, DataRow, Empty, Notice, Panel, StatusBadge, Table, ui as u } from "@/components/ui";
import { AgentCardFace } from "@/components/agent-card";
import { AddressLink, MerchantCell, pieces as p } from "@/components/pieces";
import { merchantName } from "@/config/merchants";
import { ADDRESSES, cardManagerAbi, SPEND_AUTH_TYPES } from "@/lib/contracts";
import { merchantProof } from "@/lib/merkle";
import { AGENT, TASKS, decide, intendLine, line, summarise, type Line, type TaskOutcome } from "@/lib/agent";
import { getCard, last4, listAttempts, saveAttempt, type StoredCard } from "@/lib/cards";
import { chain, fmtUsd, loadAttestations, loadCardState, publicClient, txUrl, type Attestation, type CardState } from "@/lib/chain";
import { useOwner } from "@/lib/owner-context";

export default function CardDetailPage() {
  const params = useParams<{ cardId: string }>();
  const cardId = params.cardId as Hex;
  const { busy, error, runOwnerAction } = useOwner();

  const [stored, setStored] = useState<StoredCard>();
  const [state, setState] = useState<CardState | null>(null);
  const [attestations, setAttestations] = useState<Attestation[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, TaskOutcome>>({});
  const [running, setRunning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const next = await loadCardState(cardId).catch(() => null);
    setState(next);
    if (next) setAttestations(await loadAttestations(next.agentId).catch(() => []));
  }, [cardId]);

  useEffect(() => {
    setStored(getCard(cardId));
    void refresh().finally(() => setLoaded(true));
  }, [cardId, refresh]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  const say = (...next: Line[]) => setLines((prev) => [...prev, ...next]);

  /** One pass over the agent's goal list, reacting to whatever the chain says. */
  async function run() {
    if (!stored || !state) return;
    setRunning(true);
    setLines([]);
    setOutcomes({});
    const results: Record<string, TaskOutcome> = {};

    try {
      say(line("agent", `${AGENT.name} here. ${TASKS.length} things to pay for today. Checking what this card allows.`));
      const fresh = await loadCardState(cardId);
      if (!fresh) throw new Error("card not found");
      say(
        line(
          "chain",
          `Card ${last4(stored.agentAddress)}: ${fmtUsd(fresh.remaining)} of ${fmtUsd(fresh.dailyCap)} left today, ${stored.merchants.length} merchant(s) allowed.`,
        ),
      );

      const account = privateKeyToAccount(stored.agentPrivateKey);
      let remainingUsd = Number(fresh.remaining) / 1e6;
      let policyVersion = fresh.policyVersion;

      for (const task of TASKS) {
        say(intendLine(task));

        const auth = {
          cardId,
          merchant: task.merchant,
          token: ADDRESSES.paymentToken,
          amount: BigInt(Math.round(task.amountUsd * 1e6)),
          nonce: BigInt(Date.now()),
          deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
          policyVersion: BigInt(policyVersion),
        };

        // The agent only ever signs. A relayer submits and pays the gas, including on refusal.
        const signature = await account.signTypedData({
          domain: { name: "AgentCard", version: "1", chainId: chain.id, verifyingContract: ADDRESSES.spendGate },
          types: SPEND_AUTH_TYPES,
          primaryType: "SpendAuth",
          message: auth,
        });

        const res = await fetch("/api/relay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            auth: {
              ...auth,
              amount: auth.amount.toString(),
              nonce: auth.nonce.toString(),
              deadline: auth.deadline.toString(),
              policyVersion: auth.policyVersion.toString(),
            },
            signature,
            proof: merchantProof(stored.merchants, task.merchant),
          }),
        });
        const data = (await res.json()) as { ok?: boolean; reason?: string | null; hash?: Hex; error?: string };
        if (!res.ok || data.error) throw new Error(data.error ?? "the relayer could not submit that");

        const ok = Boolean(data.ok);
        const verdict = decide(task, ok, data.reason ?? null, remainingUsd);
        say(...verdict.lines);
        results[task.id] = verdict.outcome;
        setOutcomes({ ...results });

        saveAttempt({
          id: `${cardId}-${auth.nonce}`,
          cardId,
          agentAddress: stored.agentAddress,
          agentName: stored.agentName,
          merchant: task.merchant,
          amountUsd: task.amountUsd,
          ok,
          reason: data.reason ?? null,
          hash: data.hash,
          at: Date.now(),
          task: task.goal,
        });

        if (ok) remainingUsd = Math.max(remainingUsd - task.amountUsd, 0);
        if (verdict.stopRun) {
          for (const rest of TASKS.slice(TASKS.indexOf(task) + 1)) results[rest.id] = "skipped";
          setOutcomes({ ...results });
          break;
        }
        const after = await loadCardState(cardId);
        if (after) policyVersion = after.policyVersion;
      }

      say(summarise(results));
      await refresh();
    } catch (err) {
      say(line("chain", err instanceof Error ? err.message : String(err), "declined"));
    } finally {
      setRunning(false);
    }
  }

  const revoke = () =>
    runOwnerAction("Revoking the card", async (wallet) => {
      const hash = await wallet.writeContract({
        address: ADDRESSES.cardManager,
        abi: cardManagerAbi,
        functionName: "revoke",
        args: [cardId],
        account: wallet.account!,
        chain,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refresh();
    });

  if (loaded && !state) {
    return (
      <Shell title="Card not found" subtitle="This card does not exist on-chain.">
        <Panel>
          <Empty title="Nothing here">
            <Link href="/cards">
              <Button>Back to cards</Button>
            </Link>
          </Empty>
        </Panel>
      </Shell>
    );
  }

  const attempts = listAttempts(cardId);
  const status = state?.revoked ? "revoked" : state?.expired ? "expired" : "active";

  return (
    <Shell
      title={stored ? `${stored.agentName}'s card` : "Card"}
      subtitle={stored ? `${stored.persona}. ${AGENT.brief}` : undefined}
      action={
        state && !state.revoked ? (
          <Button variant="destructive" onClick={revoke} disabled={!!busy || running}>
            {busy ?? "Revoke card"}
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
        {state?.revoked && (
          <Notice title="This card is revoked">
            Every future payment fails at the policy check. Revocation is permanent — issue a new
            card if the agent still needs to spend.
          </Notice>
        )}

        <div className={p.grid2}>
          <div className={p.stack}>
            {stored && state && (
              <AgentCardFace
                last4={last4(stored.agentAddress)}
                agentName={stored.agentName}
                persona={stored.persona}
                dailyCap={state.dailyCap}
                remaining={state.remaining}
                revoked={state.revoked}
                expired={state.expired}
                merchantCount={stored.merchants.length}
              />
            )}

            <Panel title="Policy">
              {state && (
                <>
                  <DataRow label="Status" value={<StatusBadge kind={status as "active"} />} />
                  <DataRow label="Daily limit" value={fmtUsd(state.dailyCap)} />
                  <DataRow label="Remaining today" value={state.revoked ? "—" : fmtUsd(state.remaining)} />
                  <DataRow
                    label="Merchants"
                    value={
                      stored?.merchants.length
                        ? stored.merchants.map((m) => merchantName(m)).join(", ")
                        : "any merchant"
                    }
                  />
                  <DataRow label="Expires" value={new Date(state.validUntil * 1000).toLocaleDateString()} />
                  <DataRow label="Agent key" value={<AddressLink address={state.agentKey} />} />
                  <DataRow label="ERC-8004 identity" value={`#${state.agentId}`} />
                </>
              )}
            </Panel>
          </div>

          <Panel
            title={`${AGENT.name}'s run`}
            note="The agent picks its own amounts and merchants, and decides what to do about each refusal."
            action={
              <Button variant="primary" onClick={run} disabled={running || !!busy || !state}>
                {running ? "Running…" : lines.length ? "Run again" : `Start ${AGENT.name}`}
              </Button>
            }
          >
            <div className={`${p.taskList} ${u.mb4}`}>
              {TASKS.map((t) => {
                const o = outcomes[t.id];
                return (
                  <div key={t.id} className={p.task}>
                    <span className={u.grow}>
                      <span className={p.taskGoal}>{t.goal}</span>
                      <span className={`${p.taskMeta} ${u.displayBlock}`}>
                        ${t.amountUsd} · {t.merchantName}
                      </span>
                    </span>
                    {o === "done" && <StatusBadge kind="approved" label="Paid" />}
                    {o === "deferred" && <StatusBadge kind="pending" label="Deferred" />}
                    {o === "blocked" && <StatusBadge kind="declined" label="Blocked" />}
                    {o === "halted" && <StatusBadge kind="revoked" label="Stopped" />}
                    {o === "skipped" && <StatusBadge kind="expired" label="Skipped" />}
                    {!o && running && <StatusBadge kind="pending" label="Queued" />}
                  </div>
                );
              })}
            </div>

            {lines.length === 0 ? (
              <Empty title="Not started">
                {AGENT.name} has {TASKS.length} payments to make. One fits the card, one is over the
                limit, one is at a merchant this card does not allow.
              </Empty>
            ) : (
              <div className={p.transcript} ref={logRef}>
                {lines.map((l, i) => (
                  <div key={i} className={p.line}>
                    <span className={p.who}>{l.who === "agent" ? AGENT.name : "chain"}</span>
                    <span className={l.tone === "ok" ? p.lineOk : l.tone === "declined" ? p.lineDeclined : l.tone === "note" ? p.lineNote : undefined}>
                      {l.text}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <Panel
          title="On-chain record for this card"
          note="Written by the merchants to the ERC-8004 reputation registry. We cannot write it: the registry rejects feedback from whoever holds the agent's identity, which is our own contract."
          action={<Link href="/activity">All activity</Link>}
          flush
        >
          {attestations.length === 0 ? (
            <Empty title="No attempts yet">Start the agent to create a record.</Empty>
          ) : (
            <Table head={["Merchant", "Result", "Reason", "Amount", "Transaction"]}>
              {attestations.map((a, i) => {
                const local = attempts.find((x) => x.merchant.toLowerCase() === a.client.toLowerCase() && (a.verdict === "approved") === x.ok);
                return (
                  <tr key={`${a.client}-${a.index}`}>
                    <td>
                      <MerchantCell address={a.client} />
                    </td>
                    <td>
                      {a.verdict === "approved" ? <StatusBadge kind="approved" /> : <StatusBadge kind="declined" />}
                    </td>
                    <td className={a.verdict === "approved" ? u.dim : u.danger}>
                      {a.reason === "approved" ? "—" : a.reason}
                    </td>
                    <td className={u.cellMonoMuted}>
                      {local ? `$${local.amountUsd}` : "—"}
                    </td>
                    <td>{local?.hash ? <a href={txUrl(local.hash)} target="_blank" rel="noreferrer">view</a> : <span className={u.dim}>—</span>}</td>
                  </tr>
                );
              })}
            </Table>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
