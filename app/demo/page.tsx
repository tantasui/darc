"use client";

/**
 * Agent demo panel — the 90-second demo as buttons.
 *
 * Mirrors the real architecture rather than faking it: the agent key lives in the browser
 * and only ever SIGNS an EIP-712 SpendAuth; a relayer route submits the transaction and
 * pays its gas, including for declines. The agent holds no MON and no tokens, and never
 * sends a transaction.
 *
 * DEMO-ONLY KEY HANDLING, stated plainly: the agent's private key is generated here and
 * kept in localStorage. That is not a production custody story. It is survivable only
 * because the key is capped, merchant-scoped, expiring and instantly revocable — the design
 * assumes a stolen agent key is a bounded loss, not that agent keys stay secret.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  createPublicClient,
  defineChain,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, RPC_URL } from "@/config/chain";
import { ADDRESSES, cardManagerAbi, spendGateAbi, SPEND_AUTH_TYPES } from "@/lib/contracts";

const chain = defineChain(MONAD_TESTNET);
const client = createPublicClient({ chain, transport: http(RPC_URL) });
const explorer = MONAD_TESTNET.blockExplorers.default.url;
const AGENT_KEY_STORAGE = "agentcard.demo.agentKey";

type Entry = { label: string; ok?: boolean; reason?: string | null; hash?: Hex; error?: string; pending?: boolean };

export default function DemoPage() {
  const [agentAddress, setAgentAddress] = useState<Address>();
  const [cardId, setCardId] = useState<Hex>();
  const [agentId, setAgentId] = useState<string>();
  const [remaining, setRemaining] = useState<bigint>();
  const [revoked, setRevoked] = useState(false);
  const [log, setLog] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  /** A fresh, disposable key per browser. Never derived from the passkey. */
  const agentKey = useCallback((): Hex => {
    let key = localStorage.getItem(AGENT_KEY_STORAGE) as Hex | null;
    if (!key) {
      key = generatePrivateKey();
      localStorage.setItem(AGENT_KEY_STORAGE, key);
    }
    return key;
  }, []);

  const refresh = useCallback(async (address: Address) => {
    const existing = await client.readContract({
      address: ADDRESSES.cardManager,
      abi: cardManagerAbi,
      functionName: "cardIdOfAgentKey",
      args: [address],
    });
    if (existing === "0x0000000000000000000000000000000000000000000000000000000000000000") {
      setCardId(undefined);
      return;
    }
    const [card, left, id] = await Promise.all([
      client.readContract({ address: ADDRESSES.cardManager, abi: cardManagerAbi, functionName: "getCard", args: [existing] }),
      client.readContract({ address: ADDRESSES.spendGate, abi: spendGateAbi, functionName: "remainingToday", args: [existing] }),
      client.readContract({ address: ADDRESSES.cardManager, abi: cardManagerAbi, functionName: "agentIdOfCard", args: [existing] }),
    ]);
    setCardId(existing);
    setRemaining(left);
    setRevoked(card.revoked);
    setAgentId(id.toString());
  }, []);

  useEffect(() => {
    const address = privateKeyToAccount(agentKey()).address;
    setAgentAddress(address);
    void refresh(address).catch((e) => setError(String(e)));
  }, [agentKey, refresh]);

  async function issue() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/issue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentKey: agentAddress }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "issue failed");
      setLog((l) => [...l, { label: "Card issued — $50/day, merchant A only", ok: true, hash: data.hash }]);
      if (agentAddress) await refresh(agentAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Agent signs; relayer submits. This is the whole trust model in one function. */
  async function attempt(label: string, merchant: Address, amountUsd: number) {
    if (!cardId) return;
    setBusy(true);
    setError(undefined);
    setLog((l) => [...l, { label, pending: true }]);
    try {
      const card = await client.readContract({
        address: ADDRESSES.cardManager,
        abi: cardManagerAbi,
        functionName: "getCard",
        args: [cardId],
      });

      const auth = {
        cardId,
        merchant,
        token: ADDRESSES.mockUSD,
        amount: BigInt(Math.round(amountUsd * 1e6)),
        // Timestamp-based so repeated clicks never collide; the gate rejects reuse anyway.
        nonce: BigInt(Date.now()),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
        policyVersion: card.policyVersion,
      };

      const account = privateKeyToAccount(agentKey());
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
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "relay failed");

      setLog((l) => [...l.slice(0, -1), { label, ok: data.ok, reason: data.reason, hash: data.hash }]);
      await refresh(privateKeyToAccount(agentKey()).address);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLog((l) => [...l.slice(0, -1), { label, error: message }]);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!cardId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cardId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "revoke failed");
      setLog((l) => [...l, { label: "Owner revoked the card", ok: true, hash: data.hash }]);
      if (agentAddress) await refresh(agentAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function newAgent() {
    localStorage.removeItem(AGENT_KEY_STORAGE);
    setLog([]);
    setCardId(undefined);
    setRevoked(false);
    const address = privateKeyToAccount(agentKey()).address;
    setAgentAddress(address);
    void refresh(address);
  }

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "40px 20px 72px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 6px" }}>Agent demo</h1>
      <p style={{ color: "#9aa3b2", marginTop: 0 }}>
        The agent signs; a relayer submits and pays the gas. The agent never sends a transaction and
        holds no funds — including when it is refused.
      </p>

      <div style={panel}>
        <Row k="Agent" v={agentAddress ? <Addr a={agentAddress} /> : "…"} />
        <Row k="Card" v={cardId ? (revoked ? <b style={{ color: "#f0616d" }}>REVOKED</b> : "active") : "not issued"} />
        {agentId && <Row k="ERC-8004 ID" v={agentId} />}
        {cardId && !revoked && remaining !== undefined && (
          <Row k="Remaining today" v={`$${formatUnits(remaining, 6)} of $50`} />
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "18px 0" }}>
        {!cardId ? (
          <button onClick={issue} disabled={busy || !agentAddress} style={btn("#4f7cff")}>
            {busy ? "Working…" : "1. Issue a card ($50/day, merchant A)"}
          </button>
        ) : (
          <>
            <button onClick={() => attempt("Buy $20 at merchant A", ADDRESSES.mockMerchantA, 20)} disabled={busy} style={btn("#2b3340")}>
              2. Buy $20 at A
            </button>
            <button onClick={() => attempt("Buy $200 at merchant A", ADDRESSES.mockMerchantA, 200)} disabled={busy} style={btn("#2b3340")}>
              3. Try $200 (over cap)
            </button>
            <button onClick={() => attempt("Buy $5 at merchant B", ADDRESSES.mockMerchantB, 5)} disabled={busy} style={btn("#2b3340")}>
              4. Try merchant B
            </button>
            <button onClick={revoke} disabled={busy || revoked} style={btn("#7a2530", "#f0616d")}>
              5. Revoke
            </button>
          </>
        )}
        <button onClick={newAgent} disabled={busy} style={btn("transparent", "#5b6472")}>
          New agent
        </button>
      </div>

      {error && <div style={{ ...panel, borderColor: "#f0616d" }}>{error}</div>}

      {log.length > 0 && (
        <div style={panel}>
          {log.map((e, i) => (
            <div key={i} style={{ display: "flex", gap: 10, padding: "6px 0", fontSize: 13.5, flexWrap: "wrap", alignItems: "baseline" }}>
              <span style={{ width: 14, color: e.pending ? "#e0b341" : e.error ? "#f0616d" : e.ok ? "#3fb950" : "#f0616d" }}>
                {e.pending ? "◍" : e.error ? "!" : e.ok ? "●" : "✕"}
              </span>
              <span style={{ flex: 1, minWidth: 200 }}>
                {e.label}
                {e.reason && <strong style={{ color: "#f0616d" }}> — {e.reason}</strong>}
                {e.error && <span style={{ color: "#f0616d" }}> — {e.error}</span>}
              </span>
              {e.hash && (
                <a href={`${explorer}/tx/${e.hash}`} target="_blank" rel="noreferrer" style={{ color: "#79a6ff", fontSize: 12.5 }}>
                  tx ↗
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {agentAddress && (
        <p style={{ color: "#6b7383", fontSize: 13 }}>
          Every attempt above — approved or refused — is public on-chain.{" "}
          <Link href="/verify" style={{ color: "#79a6ff" }}>
            Check this agent on the Verifier
          </Link>
          , which reads only from the canonical ERC-8004 registry.
        </p>
      )}
    </main>
  );
}

const panel = { background: "#12161c", border: "1px solid #232a35", borderRadius: 10, padding: 14, marginBottom: 14 } as const;

function btn(bg: string, border = bg) {
  return {
    padding: "10px 14px",
    borderRadius: 8,
    border: `1px solid ${border}`,
    background: bg,
    color: "#e7e9ee",
    fontWeight: 600,
    fontSize: 13.5,
    cursor: "pointer",
  } as const;
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "3px 0", fontSize: 13.5, flexWrap: "wrap" }}>
      <span style={{ color: "#7c8494", minWidth: 122 }}>{k}</span>
      <span style={{ fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{v}</span>
    </div>
  );
}

function Addr({ a }: { a: Address }) {
  return (
    <a href={`${explorer}/address/${a}`} target="_blank" rel="noreferrer" style={{ color: "#79a6ff", fontFamily: "ui-monospace, monospace" }}>
      {a.slice(0, 10)}…{a.slice(-6)}
    </a>
  );
}
