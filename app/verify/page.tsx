"use client";

/**
 * Verifier — the proof that the trail is queryable infrastructure, not private logs.
 *
 * Reads only through `eth_call`: no indexer, no archive node, no API key. That is a design
 * constraint, not a convenience. Public Monad RPCs cap `eth_getLogs` at a 100-block range,
 * so a verifier built on events could not read an agent's history at all — which is why
 * refusal reasons are written into the ERC-8004 attestations themselves (see
 * contracts/src/lib/DeclineReasons.sol).
 *
 * The attestations are authored by MERCHANTS on the canonical registry. We cannot write
 * them: the registry rejects feedback from whoever owns the agent's identity, and that is
 * our own CardManager. So the reputation half of this page is not ours to forge, and the
 * cross-check below shows whether our aggregate agrees with the raw registry.
 */
import { useCallback, useEffect, useState } from "react";
import {
  createPublicClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import { MONAD_TESTNET, RPC_URL, ERC8004 } from "@/config/chain";
import {
  ADDRESSES,
  cardManagerAbi,
  identityRegistryAbi,
  reputationReaderAbi,
  reputationRegistryAbi,
  spendGateAbi,
} from "@/lib/contracts";

const chain = defineChain(MONAD_TESTNET);
const client = createPublicClient({ chain, transport: http(RPC_URL) });
const explorer = MONAD_TESTNET.blockExplorers.default.url;

/** The agent from the recorded live demo run, so the page is never empty on first load. */
const DEMO_AGENT = "0x448c24e7e9aB4400FeA8f5D829db49f9f91732c5";

/** One merchant-written attestation. `tag1` carries the reason, `tag2` the verdict. */
type Attestation = {
  client: Address;
  index: bigint;
  value: bigint;
  reason: string;
  verdict: string;
  revoked: boolean;
};

type Result = {
  agentKey: Address;
  found: boolean;
  agentId: bigint;
  cardId: Hex;
  owner: Address;
  approvedCount: number;
  declinedCount: number;
  revoked: boolean;
  expired: boolean;
  activeSince: number;
  dailyCap: bigint;
  remainingToday: bigint;
  validUntil: number;
  policyVersion: number;
  identityOwner?: Address;
  agentWallet?: Address;
  attestations: Attestation[];
};

export default function VerifyPage() {
  const [input, setInput] = useState(DEMO_AGENT);
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const lookup = useCallback(async (raw: string) => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      if (!isAddress(raw.trim())) throw new Error("That is not a valid address.");
      const agentKey = getAddress(raw.trim());

      const report = await client.readContract({
        address: ADDRESSES.reputationReader,
        abi: reputationReaderAbi,
        functionName: "reportForAgentKey",
        args: [agentKey],
      });

      if (!report.found) {
        setResult({
          agentKey,
          found: false,
          agentId: 0n,
          cardId: "0x",
          owner: "0x" as Address,
          approvedCount: 0,
          declinedCount: 0,
          revoked: false,
          expired: false,
          activeSince: 0,
          dailyCap: 0n,
          remainingToday: 0n,
          validUntil: 0,
          policyVersion: 0,
          attestations: [],
        });
        return;
      }

      const [card, remainingToday, identityOwner, agentWallet, clients] = await Promise.all([
        client.readContract({
          address: ADDRESSES.cardManager,
          abi: cardManagerAbi,
          functionName: "getCard",
          args: [report.cardId],
        }),
        client.readContract({
          address: ADDRESSES.spendGate,
          abi: spendGateAbi,
          functionName: "remainingToday",
          args: [report.cardId],
        }),
        client
          .readContract({
            address: ERC8004.identityRegistry,
            abi: identityRegistryAbi,
            functionName: "ownerOf",
            args: [report.agentId],
          })
          .catch(() => undefined),
        client
          .readContract({
            address: ERC8004.identityRegistry,
            abi: identityRegistryAbi,
            functionName: "getAgentWallet",
            args: [report.agentId],
          })
          .catch(() => undefined),
        client.readContract({
          address: ERC8004.reputationRegistry,
          abi: reputationRegistryAbi,
          functionName: "getClients",
          args: [report.agentId],
        }),
      ]);

      // Merchant-written attestations, straight from the canonical registry.
      let attestations: Attestation[] = [];
      if (clients.length > 0) {
        const feedback = await client.readContract({
          address: ERC8004.reputationRegistry,
          abi: reputationRegistryAbi,
          functionName: "readAllFeedback",
          args: [report.agentId, clients as Address[], "", "", false],
        });
        attestations = feedback[0].map((c, i) => ({
          client: c as Address,
          index: BigInt(feedback[1][i]),
          value: BigInt(feedback[2][i]),
          reason: feedback[4][i],
          verdict: feedback[5][i],
          revoked: feedback[6][i],
        }));
      }

      setResult({
        agentKey,
        found: true,
        agentId: report.agentId,
        cardId: report.cardId,
        owner: report.owner,
        approvedCount: Number(report.approvedCount),
        declinedCount: Number(report.declinedCount),
        revoked: report.revoked,
        expired: report.expired,
        activeSince: Number(report.activeSince),
        dailyCap: card.dailyCap,
        remainingToday,
        validUntil: Number(card.validUntil),
        policyVersion: Number(card.policyVersion),
        identityOwner: identityOwner as Address | undefined,
        agentWallet: agentWallet as Address | undefined,
        attestations,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void lookup(DEMO_AGENT);
  }, [lookup]);

  const verdict = !result
    ? null
    : !result.found
      ? { text: "No card found for this address", tone: "#7c8494" }
      : result.revoked
        ? { text: "REVOKED — do not transact", tone: "#f0616d" }
        : result.expired
          ? { text: "EXPIRED — card is past its validity", tone: "#e0b341" }
          : { text: "ACTIVE — card is live and unrevoked", tone: "#3fb950" };

  const approvedSeen = result?.attestations.filter((a) => a.verdict === "approved").length ?? 0;
  const declinedSeen = result?.attestations.filter((a) => a.verdict === "declined").length ?? 0;
  const consistent = result ? result.approvedCount === approvedSeen && result.declinedCount === declinedSeen : true;

  return (
    <main style={{ maxWidth: 780, margin: "0 auto", padding: "40px 20px 72px" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 6px" }}>Verify an agent</h1>
      <p style={{ color: "#9aa3b2", marginTop: 0 }}>
        Anyone can check an agent&apos;s spending record straight from Monad Testnet. No account, no
        API key, no trust in us.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void lookup(input);
        }}
        style={{ display: "flex", gap: 8, margin: "22px 0" }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="0x… agent address"
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 0,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid #232a35",
            background: "#12161c",
            color: "#e7e9ee",
            fontFamily: "ui-monospace, monospace",
            fontSize: 13,
          }}
        />
        <button
          type="submit"
          disabled={busy}
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            border: "1px solid #4f7cff",
            background: "#4f7cff",
            color: "#fff",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {busy ? "Checking…" : "Verify"}
        </button>
      </form>

      {error && <div style={{ ...panel, borderColor: "#f0616d" }}>{error}</div>}

      {verdict && (
        <div style={{ ...panel, borderColor: verdict.tone }}>
          <div style={{ color: verdict.tone, fontWeight: 700, fontSize: 15 }}>{verdict.text}</div>
          {result?.found && (
            <div style={{ display: "flex", gap: 22, marginTop: 10, flexWrap: "wrap" }}>
              <Stat label="approved" value={result.approvedCount} tone="#3fb950" />
              <Stat label="declined" value={result.declinedCount} tone="#f0616d" />
              <Stat label="attestations" value={result.attestations.length} />
              <Stat label="raters" value={new Set(result.attestations.map((a) => a.client)).size} />
            </div>
          )}
        </div>
      )}

      {result?.found && (
        <>
          <Section title="Card policy">
            <Row k="Owner" v={<Addr a={result.owner} />} />
            <Row k="Daily cap" v={`$${formatUnits(result.dailyCap, 6)}`} />
            <Row k="Remaining today" v={`$${formatUnits(result.remainingToday, 6)}`} />
            <Row k="Valid until" v={new Date(result.validUntil * 1000).toUTCString()} />
            <Row k="Issued" v={new Date(result.activeSince * 1000).toUTCString()} />
            <Row k="Policy version" v={String(result.policyVersion)} />
          </Section>

          <Section title="ERC-8004 identity" note="Canonical registry, at the same address on every chain.">
            <Row k="Agent ID" v={String(result.agentId)} />
            <Row k="Identity held by" v={result.identityOwner ? <Addr a={result.identityOwner} /> : "—"} />
            <Row k="agentWallet" v={result.agentWallet ? <Addr a={result.agentWallet} /> : "—"} />
            <Row k="Registry" v={<Addr a={ERC8004.identityRegistry} />} />
          </Section>

          <Section
            title="Attestations, written by merchants"
            note="On the canonical ERC-8004 registry. We cannot write these: the registry rejects feedback from whoever owns the agent's identity, and that is our CardManager. Each refusal carries the reason it was refused."
          >
            {result.attestations.length === 0 ? (
              <Empty>No attestations yet.</Empty>
            ) : (
              result.attestations.map((a) => (
                <div key={`${a.client}-${a.index}`} style={rowLine}>
                  <span
                    style={{
                      color: a.verdict === "approved" ? "#3fb950" : "#f0616d",
                      minWidth: 74,
                      fontWeight: 600,
                    }}
                  >
                    {a.verdict}
                  </span>
                  <span style={{ minWidth: 152 }}>{a.reason === "approved" ? "—" : a.reason}</span>
                  <span style={{ color: "#7c8494", minWidth: 60 }}>score {String(a.value)}</span>
                  <Addr a={a.client} />
                </div>
              ))
            )}
          </Section>

          <Section
            title="Cross-check"
            note="The first line is our ReputationReader aggregating the registry. The second counts the raw attestations read directly from it. They should agree."
          >
            <Row k="Our reader says" v={`${result.approvedCount} approved, ${result.declinedCount} declined`} />
            <Row k="Registry says" v={`${approvedSeen} approved, ${declinedSeen} declined`} />
            <Row
              k="Agreement"
              v={
                <span style={{ color: consistent ? "#3fb950" : "#f0616d", fontWeight: 600 }}>
                  {consistent ? "consistent" : "MISMATCH — investigate"}
                </span>
              }
            />
          </Section>

          <p style={{ color: "#6b7383", fontSize: 13 }}>
            Every figure above comes from contract calls to the canonical ERC-8004 registry and our
            deployed contracts — no indexer, no archive node, no API key. Refusal reasons live in the
            attestations themselves because public Monad RPCs cap event queries at a 100-block range;
            a verifier built on logs could not read history at all.
          </p>
        </>
      )}
    </main>
  );
}

const panel = {
  background: "#12161c",
  border: "1px solid #232a35",
  borderRadius: 10,
  padding: 14,
  marginBottom: 16,
} as const;

const rowLine = {
  display: "flex",
  gap: 12,
  alignItems: "baseline",
  padding: "5px 0",
  fontSize: 13,
  flexWrap: "wrap" as const,
};

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section style={panel}>
      <h2
        style={{
          fontSize: 14,
          margin: "0 0 4px",
          letterSpacing: 0.3,
          textTransform: "uppercase",
          color: "#9aa3b2",
        }}
      >
        {title}
      </h2>
      {note && <p style={{ color: "#6b7383", fontSize: 12.5, margin: "0 0 10px" }}>{note}</p>}
      {children}
    </section>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "3px 0", fontSize: 13.5, flexWrap: "wrap" }}>
      <span style={{ color: "#7c8494", minWidth: 132 }}>{k}</span>
      <span style={{ fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{v}</span>
    </div>
  );
}

function Stat({ label, value, tone = "#e7e9ee" }: { label: string; value: number; tone?: string }) {
  return (
    <span style={{ fontSize: 13, color: "#7c8494" }}>
      <strong style={{ color: tone, fontSize: 19, marginRight: 5 }}>{value}</strong>
      {label}
    </span>
  );
}

function Addr({ a }: { a: Address }) {
  return (
    <a
      href={`${explorer}/address/${a}`}
      target="_blank"
      rel="noreferrer"
      style={{ color: "#79a6ff", fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}
    >
      {a.slice(0, 10)}…{a.slice(-6)}
    </a>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ color: "#6b7383", fontSize: 13 }}>{children}</div>;
}
