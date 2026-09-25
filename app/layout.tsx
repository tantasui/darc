import type { ReactNode } from "react";

export const metadata = {
  title: "AgentCard",
  description: "Passkey-secured, scoped, revocable cards for AI agents on Monad",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: "#0b0d10",
          color: "#e7e9ee",
          font: "15px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif",
        }}
      >
        {children}
      </body>
    </html>
  );
}
