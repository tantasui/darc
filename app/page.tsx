import Link from "next/link";
import { ADDRESSES } from "@/config/addresses";
import { MONAD_TESTNET } from "@/config/chain";

const SURFACES = [
  {
    href: "/console",
    title: "Owner console",
    body: "Sign in with a passkey, issue a card with a daily limit and allowed merchants, revoke it instantly. No seed phrase; the key never reaches a server.",
    cta: "#4f7cff",
  },
  {
    href: "/demo",
    title: "Agent demo",
    body: "Watch an agent spend inside its policy, then get refused for exceeding the cap and for an out-of-scope merchant. It only signs — a relayer pays the gas.",
  },
  {
    href: "/verify",
    title: "Verifier",
    body: "Look up any agent and read its record straight from the canonical ERC-8004 registry. No account, no API key, no trust in us.",
  },
  {
    href: "/mera",
    title: "Passkey check",
    body: "Proves a passkey derives an account that signs and transacts on Monad Testnet, step by step.",
  },
] as const;

export default function Home() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 20px 72px" }}>
      <h1 style={{ fontSize: 27, margin: "0 0 8px" }}>AgentCard</h1>
      <p style={{ color: "#9aa3b2", margin: "0 0 6px", fontSize: 15.5 }}>
        Agents should never hold your keys. They hold scoped, revocable, policy-bound cards —
        and every attempt, approved <em>or refused</em>, is public on-chain.
      </p>
      <p style={{ color: "#6b7383", margin: "0 0 30px", fontSize: 13.5 }}>
        Live on {MONAD_TESTNET.name} · all contracts verified ·{" "}
        <a
          href={`${MONAD_TESTNET.blockExplorers.default.url}/address/${ADDRESSES.cardManager}`}
          target="_blank"
          rel="noreferrer"
          style={{ color: "#79a6ff" }}
        >
          CardManager
        </a>
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        {SURFACES.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            style={{
              display: "block",
              padding: 16,
              borderRadius: 10,
              border: `1px solid ${"cta" in s ? "#33478f" : "#232a35"}`,
              background: "#12161c",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 15.5, marginBottom: 4 }}>
              {s.title} <span style={{ color: "#79a6ff" }}>→</span>
            </div>
            <div style={{ color: "#9aa3b2", fontSize: 13.5, lineHeight: 1.5 }}>{s.body}</div>
          </Link>
        ))}
      </div>

      <p style={{ color: "#6b7383", fontSize: 12.5, marginTop: 28 }}>
        Testnet demo. Agent keys are held in the browser and the demo routes use throwaway keys —
        see the README for what is and is not a production custody story.
      </p>
    </main>
  );
}
