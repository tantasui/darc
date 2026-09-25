"use client";

/**
 * Mera passkey check — the one step that cannot be tested headlessly.
 *
 * `scripts/mera-check.ts` already proves derivation, signing, determinism and a real
 * Monad transaction using a stand-in PRF value. What is unproven until a human runs this
 * page on a real device is the WebAuthn ceremony: whether the authenticator supports the
 * PRF extension at all. So this page reports each step separately -- a failure at step 1
 * is a provider problem, not a bug in AgentCard.
 */
import { useEffect, useState } from "react";
import { createPublicClient, createWalletClient, defineChain, formatEther, http } from "viem";
import { MONAD_TESTNET, RPC_URL, GAS } from "@/config/chain";
import { clearCredential, explainError, loadCredential, openOwnerSession, DERIVATION_PATH } from "@/lib/mera";

const chain = defineChain(MONAD_TESTNET);

type Step = { label: string; state: "pending" | "running" | "ok" | "fail"; detail?: string };

const STEPS: string[] = [
  "Passkey ceremony (PRF extension)",
  "Derive EOA (PRF → BIP-39 → BIP-32)",
  "Sign an EIP-712 SpendAuth",
  "Send a transaction on Monad Testnet",
  "End session (key no longer usable)",
];

export default function MeraCheckPage() {
  const [steps, setSteps] = useState<Step[]>(STEPS.map((label) => ({ label, state: "pending" })));
  const [address, setAddress] = useState<string>();
  const [balance, setBalance] = useState<string>();
  const [txHash, setTxHash] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [hasCredential, setHasCredential] = useState(false);
  const [secure, setSecure] = useState(true);

  useEffect(() => {
    setHasCredential(loadCredential() !== null);
    // WebAuthn needs a secure context: HTTPS, or localhost.
    setSecure(window.isSecureContext && typeof window.PublicKeyCredential !== "undefined");
  }, []);

  const set = (i: number, patch: Partial<Step>) =>
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  async function run(mode: "create" | "signIn") {
    setBusy(true);
    setError(undefined);
    setTxHash(undefined);
    setAddress(undefined);
    setBalance(undefined);
    setSteps(STEPS.map((label) => ({ label, state: "pending" })));

    let end: (() => void) | undefined;
    try {
      // 1 + 2: the ceremony and the derivation happen together.
      set(0, { state: "running" });
      const rpId = window.location.hostname;
      const session = await openOwnerSession(mode, rpId);
      end = session.end;
      set(0, { state: "ok", detail: `rpId ${rpId}` });
      set(1, { state: "ok", detail: DERIVATION_PATH });
      setAddress(session.account.address);
      setHasCredential(true);

      // 3: the signature the owner console actually needs.
      set(2, { state: "running" });
      const sig = await session.account.signTypedData({
        domain: { name: "AgentCard", version: "1", chainId: chain.id },
        types: { Probe: [{ name: "note", type: "string" }] },
        primaryType: "Probe",
        message: { note: "mera check" },
      });
      set(2, { state: "ok", detail: `${sig.slice(0, 18)}… (${sig.length} chars)` });

      // 4: a real transaction, which is the claim that matters.
      set(3, { state: "running" });
      const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
      const bal = await publicClient.getBalance({ address: session.account.address });
      setBalance(formatEther(bal));
      if (bal === 0n) {
        set(3, {
          state: "fail",
          detail: "This account has no MON. Fund the address above, then run the check again.",
        });
      } else {
        const wallet = createWalletClient({ account: session.account, chain, transport: http(RPC_URL) });
        // Explicit gas: Monad charges the declared gasLimit, not gas used.
        const hash = await wallet.sendTransaction({
          to: session.account.address,
          value: 0n,
          gas: GAS.transfer,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        setTxHash(hash);
        set(3, { state: receipt.status === "success" ? "ok" : "fail", detail: `block ${receipt.blockNumber}` });
      }

      // 5: prompt-per-transaction hygiene — the key must not outlive the action.
      set(4, { state: "running" });
      end();
      end = undefined;
      try {
        await session.account.signMessage({ message: "after end" });
        set(4, { state: "fail", detail: "signing still worked after end()" });
      } catch {
        set(4, { state: "ok", detail: "SESSION_ENDED as expected" });
      }
    } catch (err) {
      setError(explainError(err));
      setSteps((prev) => {
        const i = prev.findIndex((s) => s.state === "running");
        return i === -1 ? prev : prev.map((s, idx) => (idx === i ? { ...s, state: "fail" } : s));
      });
    } finally {
      end?.(); // never leave the key alive on an error path
      setBusy(false);
    }
  }

  const mark = { pending: "○", running: "◍", ok: "●", fail: "✕" } as const;
  const colour = { pending: "#5b6472", running: "#e0b341", ok: "#3fb950", fail: "#f0616d" } as const;

  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "40px 20px 64px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 6px" }}>Mera passkey check</h1>
      <p style={{ color: "#9aa3b2", marginTop: 0 }}>
        Proves a passkey can derive an EOA that signs and transacts on Monad Testnet. Needs a
        PRF-capable provider: iCloud Keychain, 1Password, or Google Password Manager.
      </p>

      {!secure && (
        <p style={{ background: "#3a2326", border: "1px solid #f0616d", padding: 12, borderRadius: 8 }}>
          This page needs a secure context with WebAuthn. Open it on <code>localhost</code> or over HTTPS.
        </p>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "22px 0" }}>
        <button onClick={() => run("create")} disabled={busy || !secure} style={btn("#4f7cff")}>
          {busy ? "Working…" : "Create a passkey"}
        </button>
        <button onClick={() => run("signIn")} disabled={busy || !secure} style={btn("#2b3340")}>
          Sign in with existing passkey
        </button>
        {hasCredential && (
          <button
            onClick={() => {
              clearCredential();
              setHasCredential(false);
            }}
            disabled={busy}
            style={btn("transparent", "#5b6472")}
          >
            Forget stored credential
          </button>
        )}
      </div>

      <ol style={{ listStyle: "none", padding: 0, margin: "0 0 24px" }}>
        {steps.map((s) => (
          <li key={s.label} style={{ display: "flex", gap: 10, padding: "7px 0", alignItems: "baseline" }}>
            <span style={{ color: colour[s.state], width: 16 }}>{mark[s.state]}</span>
            <span style={{ flex: 1 }}>
              {s.label}
              {s.detail && (
                <span style={{ color: "#7c8494", fontSize: 13, display: "block", wordBreak: "break-all" }}>
                  {s.detail}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>

      {address && (
        <div style={panel}>
          <Row k="Derived address" v={address} />
          {balance !== undefined && <Row k="Balance" v={`${balance} MON`} />}
          {txHash && (
            <Row
              k="Transaction"
              v={
                <a
                  href={`${MONAD_TESTNET.blockExplorers.default.url}/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#79a6ff" }}
                >
                  {txHash.slice(0, 22)}…
                </a>
              }
            />
          )}
        </div>
      )}

      {error && (
        <div style={{ ...panel, background: "#2a1c1f", borderColor: "#f0616d" }}>
          <strong style={{ color: "#f0616d" }}>Failed</strong>
          <p style={{ margin: "6px 0 0" }}>{error}</p>
        </div>
      )}

      <p style={{ color: "#6b7383", fontSize: 13, marginTop: 28 }}>
        No seed phrase is ever shown. The passkey is the derivation root and the recovery
        mechanism, not an on-chain signer — the result is a plain secp256k1 EOA. Passkeys are bound
        to this domain (<code>rpId</code>), so an account created here is unreachable from a
        different domain.
      </p>
    </main>
  );
}

const panel = {
  background: "#12161c",
  border: "1px solid #232a35",
  borderRadius: 10,
  padding: 14,
  marginBottom: 14,
} as const;

function btn(bg: string, border = bg) {
  return {
    padding: "10px 15px",
    borderRadius: 8,
    border: `1px solid ${border}`,
    background: bg,
    color: "#e7e9ee",
    fontWeight: 600,
    fontSize: 14,
    cursor: "pointer",
  } as const;
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "4px 0", fontSize: 14 }}>
      <span style={{ color: "#7c8494", minWidth: 120 }}>{k}</span>
      <span style={{ fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{v}</span>
    </div>
  );
}
