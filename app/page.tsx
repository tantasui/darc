import Link from "next/link";

export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ fontSize: 26, margin: "0 0 8px" }}>AgentCard</h1>
      <p style={{ color: "#9aa3b2", margin: "0 0 28px" }}>
        Scoped, revocable, policy-bound cards for AI agents. Live on Monad Testnet.
      </p>
      <Link
        href="/mera"
        style={{
          display: "inline-block",
          padding: "11px 16px",
          borderRadius: 8,
          background: "#4f7cff",
          color: "#fff",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        Run the Mera passkey check →
      </Link>
    </main>
  );
}
