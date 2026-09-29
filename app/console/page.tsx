"use client";

/**
 * Owner console — the human side, gated by a passkey.
 *
 * PROMPT-PER-TRANSACTION, deliberately. Every owner action (fund, approve, issue, revoke)
 * runs its own passkey ceremony and ends the session in a `finally` block. Owner actions are
 * rare and high-stakes, so a biometric prompt each time is a security feature, not friction:
 * the derived key never outlives the action it authorized, and there is no long-lived session
 * sitting in page memory between unrelated clicks.
 *
 * The owner key is derived from the passkey in this browser and never reaches a server. That
 * is the difference between this page and /demo, whose API routes hold a stand-in owner key
 * server-side so the demo stays clickable.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, RPC_URL } from "@/config/chain";
import { ADDRESSES, cardManagerAbi, mockUsdAbi, spendGateAbi } from "@/lib/contracts";
import { merchantRoot } from "@/lib/merkle";
import { clearCredential, explainError, loadCredential, openOwnerSession } from "@/lib/mera";

const chain = defineChain(MONAD_TESTNET);
const client = createPublicClient({ chain, transport: http(RPC_URL) });
const explorer = MONAD_TESTNET.blockExplorers.default.url;

/** Shared with /demo: issuing here hands the agent runtime its key. */
const AGENT_KEY_STORAGE = "agentcard.demo.agentKey";
/** Bounded on purpose: an infinite approval would sit upstream of every card policy. */
const APPROVAL = 500_000_000n;

const MERCHANTS = [
  { name: "Merchant A", address: ADDRESSES.mockMerchantA },
  { name: "Merchant B", address: ADDRESSES.mockMerchantB },
] as const;

type CardView = {
  cardId: Hex;
  agentKey: Address;
  agentId: string;
  dailyCap: bigint;
  remaining: bigint;
  revoked: boolean;
  validUntil: number;
};

export default function ConsolePage() {
  const [owner, setOwner] = useState<Address>();
  const [mon, setMon] = useState<bigint>();
  const [usd, setUsd] = useState<bigint>();
  const [allowance, setAllowance] = useState<bigint>();
  const [card, setCard] = useState<CardView>();
  const [cap, setCap] = useState(50);
  const [picked, setPicked] = useState<Address[]>([ADDRESSES.mockMerchantA]);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [secure, setSecure] = useState(true);
  const [known, setKnown] = useState(false);

  useEffect(() => {
    setKnown(loadCredential() !== null);
    setSecure(window.isSecureContext && typeof window.PublicKeyCredential !== "undefined");
  }, []);

  const refresh = useCallback(async (address: Address) => {
    const [balance, tokens, approved] = await Promise.all([
      client.getBalance({ address }),
      client.readContract({ address: ADDRESSES.mockUSD, abi: mockUsdAbi, functionName: "balanceOf", args: [address] }),
      client.readContract({
        address: ADDRESSES.mockUSD,
        abi: mockUsdAbi,
        functionName: "allowance",
        args: [address, ADDRESSES.spendGate],
      }),
    ]);
    setMon(balance);
    setUsd(tokens);
    setAllowance(approved);

    const agentKey = localStorage.getItem(AGENT_KEY_STORAGE) as Hex | null;
    if (!agentKey) return setCard(undefined);
    const agentAddress = privateKeyToAccount(agentKey).address;
    const cardId = await client.readContract({
      address: ADDRESSES.cardManager,
      abi: cardManagerAbi,
      functionName: "cardIdFor",
      args: [address, agentAddress],
    });
    const record = await client.readContract({
      address: ADDRESSES.cardManager,
      abi: cardManagerAbi,
      functionName: "getCard",
      args: [cardId],
    });
    if (record.agentKey === "0x0000000000000000000000000000000000000000") return setCard(undefined);

    const [remaining, agentId] = await Promise.all([
      client.readContract({ address: ADDRESSES.spendGate, abi: spendGateAbi, functionName: "remainingToday", args: [cardId] }),
      client.readContract({ address: ADDRESSES.cardManager, abi: cardManagerAbi, functionName: "agentIdOfCard", args: [cardId] }),
    ]);
    setCard({
      cardId,
      agentKey: record.agentKey,
      agentId: agentId.toString(),
      dailyCap: record.dailyCap,
      remaining,
      revoked: record.revoked,
      validUntil: Number(record.validUntil),
    });
  }, []);

  /**
   * Runs one passkey ceremony, hands the caller a wallet, and always ends the session.
   * Every owner action goes through here — that is what makes the guarantee uniform.
   */
  async function withOwner<T>(mode: "create" | "signIn", what: string, fn: (wallet: ReturnType<typeof createWalletClient>, address: Address) => Promise<T>) {
    setBusy(true);
    setError(undefined);
    setStatus(`${what}: waiting for your passkey…`);
    let end: (() => void) | undefined;
    try {
      const session = await openOwnerSession(mode, window.location.hostname);
      end = session.end;
      setOwner(session.account.address);
      setKnown(true);
      const wallet = createWalletClient({ account: session.account, chain, transport: http(RPC_URL) });
      setStatus(`${what}…`);
      const result = await fn(wallet, session.account.address);
      await refresh(session.account.address);
      setStatus(`${what}: done`);
      return result;
    } catch (err) {
      setError(explainError(err));
      setStatus(undefined);
    } finally {
      end?.(); // the key must not outlive the action it authorized
      setBusy(false);
    }
  }

  const signIn = (mode: "create" | "signIn") =>
    withOwner(mode, mode === "create" ? "Creating your account" : "Signing in", async (_w, address) => {
      // A fresh passkey account holds nothing; pre-fund it so onboarding has no faucet detour.
      await fetch("/api/fund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
    });

  const prepare = () =>
    withOwner("signIn", "Funding the card", async (wallet, address) => {
      if ((usd ?? 0n) < 100_000_000n) {
        const hash = await wallet.writeContract({
          address: ADDRESSES.mockUSD,
          abi: mockUsdAbi,
          functionName: "faucet",
          account: wallet.account!,
          chain,
        });
        await client.waitForTransactionReceipt({ hash });
      }
      const current = await client.readContract({
        address: ADDRESSES.mockUSD,
        abi: mockUsdAbi,
        functionName: "allowance",
        args: [address, ADDRESSES.spendGate],
      });
      if (current < APPROVAL) {
        const hash = await wallet.writeContract({
          address: ADDRESSES.mockUSD,
          abi: mockUsdAbi,
          functionName: "approve",
          args: [ADDRESSES.spendGate, APPROVAL],
          account: wallet.account!,
          chain,
        });
        await client.waitForTransactionReceipt({ hash });
      }
    });

  const issue = () =>
    withOwner("signIn", "Issuing the card", async (wallet) => {
      // A fresh, random agent key: independently revocable and disposable by design, never
      // derived from the passkey.
      const agentPrivateKey = generatePrivateKey();
      const agentAddress = privateKeyToAccount(agentPrivateKey).address;
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);

      const hash = await wallet.writeContract({
        address: ADDRESSES.cardManager,
        abi: cardManagerAbi,
        functionName: "issueCard",
        args: [agentAddress, BigInt(cap) * 1_000_000n, merchantRoot(picked), validUntil, "ipfs://agentcard-demo"],
        account: wallet.account!,
        chain,
      });
      await client.waitForTransactionReceipt({ hash });
      // Hand the agent runtime its key. Demo-only custody, stated plainly in the README.
      localStorage.setItem(AGENT_KEY_STORAGE, agentPrivateKey);
    });

  const revoke = () =>
    withOwner("signIn", "Revoking the card", async (wallet) => {
      if (!card) return;
      const hash = await wallet.writeContract({
        address: ADDRESSES.cardManager,
        abi: cardManagerAbi,
        functionName: "revoke",
        args: [card.cardId],
        account: wallet.account!,
        chain,
      });
      await client.waitForTransactionReceipt({ hash });
    });

  const ready = (mon ?? 0n) > 0n && (usd ?? 0n) > 0n && (allowance ?? 0n) > 0n;
  const last4 = card?.agentKey.slice(-4).toUpperCase();

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "40px 20px 72px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 6px" }}>Owner console</h1>
      <p style={{ color: "#9aa3b2", marginTop: 0 }}>
        Your account comes from your passkey — no seed phrase, and the key never reaches a server.
        Each action asks for your passkey once, then forgets the key.
      </p>

      {!secure && (
        <div style={{ ...panel, borderColor: "#f0616d" }}>
          WebAuthn needs a secure context. Open this on <code>localhost</code> or over HTTPS.
        </div>
      )}

      {!owner ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "20px 0" }}>
          <button onClick={() => signIn("create")} disabled={busy || !secure} style={btn("#4f7cff")}>
            {busy ? "Working…" : "Create an account with a passkey"}
          </button>
          <button onClick={() => signIn("signIn")} disabled={busy || !secure} style={btn("#2b3340")}>
            Sign in
          </button>
          {known && (
            <button
              onClick={() => {
                clearCredential();
                setKnown(false);
              }}
              disabled={busy}
              style={btn("transparent", "#5b6472")}
            >
              Forget this passkey
            </button>
          )}
        </div>
      ) : (
        <>
          <div style={panel}>
            <Row k="Your account" v={<Addr a={owner} />} />
            <Row k="Gas" v={mon !== undefined ? `${Number(formatEther(mon)).toFixed(3)} MON` : "…"} />
            <Row k="Balance" v={usd !== undefined ? `$${formatUnits(usd, 6)}` : "…"} />
            <Row
              k="Approved to spend"
              v={allowance !== undefined ? (allowance > 0n ? `$${formatUnits(allowance, 6)} (bounded)` : "none yet") : "…"}
            />
          </div>

          {!ready && (
            <div style={panel}>
              <p style={{ margin: "0 0 10px", fontSize: 13.5 }}>
                Before issuing a card, your account needs test dollars and a bounded approval to
                SpendGate. Unbounded approval is deliberately not offered: it would sit upstream of
                every card policy.
              </p>
              <button onClick={prepare} disabled={busy} style={btn("#4f7cff")}>
                {busy ? "Working…" : "Add test dollars and approve"}
              </button>
            </div>
          )}

          {ready && !card && (
            <div style={panel}>
              <h2 style={h2}>Issue a card</h2>
              <label style={{ display: "block", fontSize: 13.5, color: "#9aa3b2", margin: "8px 0 4px" }}>
                Daily limit: <strong style={{ color: "#e7e9ee" }}>${cap}</strong>
              </label>
              <input
                type="range"
                min={10}
                max={200}
                step={10}
                value={cap}
                onChange={(e) => setCap(Number(e.target.value))}
                style={{ width: "100%" }}
              />
              <div style={{ margin: "12px 0 14px" }}>
                <div style={{ fontSize: 13.5, color: "#9aa3b2", marginBottom: 6 }}>Allowed merchants</div>
                {MERCHANTS.map((m) => (
                  <label key={m.address} style={{ display: "block", fontSize: 13.5, padding: "3px 0" }}>
                    <input
                      type="checkbox"
                      checked={picked.includes(m.address)}
                      onChange={(e) =>
                        setPicked((p) => (e.target.checked ? [...p, m.address] : p.filter((x) => x !== m.address)))
                      }
                      style={{ marginRight: 8 }}
                    />
                    {m.name}
                  </label>
                ))}
                <div style={{ color: "#6b7383", fontSize: 12.5, marginTop: 4 }}>
                  None selected means any merchant — an explicit wildcard, not an accident.
                </div>
              </div>
              <button onClick={issue} disabled={busy} style={btn("#4f7cff")}>
                {busy ? "Working…" : "Issue card"}
              </button>
            </div>
          )}

          {card && (
            <div style={{ ...panel, borderColor: card.revoked ? "#f0616d" : "#3fb950" }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: 0.5 }}>Card •• {last4}</div>
                  <div style={{ color: "#9aa3b2", fontSize: 13.5, marginTop: 3 }}>
                    ${formatUnits(card.dailyCap, 6)}/day · {picked.length === 0 ? "any merchant" : `${picked.length} merchant${picked.length > 1 ? "s" : ""}`}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ color: card.revoked ? "#f0616d" : "#3fb950", fontWeight: 700 }}>
                    {card.revoked ? "REVOKED" : "ACTIVE"}
                  </div>
                  {!card.revoked && (
                    <div style={{ color: "#9aa3b2", fontSize: 13 }}>
                      ${formatUnits(card.remaining, 6)} left today
                    </div>
                  )}
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <Row k="Agent" v={<Addr a={card.agentKey} />} />
                <Row k="ERC-8004 ID" v={card.agentId} />
                <Row k="Expires" v={new Date(card.validUntil * 1000).toUTCString()} />
              </div>

              {!card.revoked && (
                <button onClick={revoke} disabled={busy} style={{ ...btn("#7a2530", "#f0616d"), marginTop: 12 }}>
                  {busy ? "Working…" : "Revoke this card"}
                </button>
              )}
              <p style={{ color: "#6b7383", fontSize: 13, marginBottom: 0 }}>
                Revocation is instant and total, and there is no un-revoke: a new card is a new
                issuance.{" "}
                <Link href="/demo" style={{ color: "#79a6ff" }}>
                  Run the agent
                </Link>{" "}
                or{" "}
                <Link href="/verify" style={{ color: "#79a6ff" }}>
                  verify it publicly
                </Link>
                .
              </p>
            </div>
          )}
        </>
      )}

      {status && !error && <div style={{ ...panel, color: "#9aa3b2" }}>{status}</div>}
      {error && <div style={{ ...panel, borderColor: "#f0616d" }}>{error}</div>}
    </main>
  );
}

const panel = { background: "#12161c", border: "1px solid #232a35", borderRadius: 10, padding: 14, marginBottom: 14 } as const;
const h2 = { fontSize: 14, margin: "0 0 4px", textTransform: "uppercase" as const, letterSpacing: 0.3, color: "#9aa3b2" };

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
      <span style={{ color: "#7c8494", minWidth: 132 }}>{k}</span>
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
