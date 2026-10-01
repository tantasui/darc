import type { ReactNode } from "react";
import type { Metadata } from "next";
import { OwnerProvider } from "@/lib/owner-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentCard — spending cards for AI agents",
  description:
    "Issue scoped, revocable, policy-bound payment cards to AI agents. Every attempt, approved or refused, is public on-chain.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <OwnerProvider>{children}</OwnerProvider>
      </body>
    </html>
  );
}
