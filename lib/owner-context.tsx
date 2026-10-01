"use client";

/**
 * Who is signed in, shared across the shell.
 *
 * Only the ADDRESS is kept (in sessionStorage, so it clears with the tab). There is no
 * session key and no long-lived signer: every owner action runs its own passkey ceremony via
 * `runOwnerAction` and ends it in a `finally` block, so the derived key never outlives the
 * action that needed it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createWalletClient, defineChain, http, type Address, type WalletClient } from "viem";
import { MONAD_TESTNET, RPC_URL } from "@/config/chain";
import { clearCredential, explainError, openOwnerSession } from "./mera";

const chain = defineChain(MONAD_TESTNET);
const STORAGE = "agentcard.owner";

type Ctx = {
  owner?: Address;
  busy: string | null;
  error?: string;
  clearError: () => void;
  signIn: (mode: "create" | "signIn") => Promise<Address | undefined>;
  signOut: () => void;
  runOwnerAction: <T>(
    label: string,
    fn: (wallet: WalletClient, owner: Address) => Promise<T>,
  ) => Promise<T | undefined>;
};

const OwnerContext = createContext<Ctx | null>(null);

export function OwnerProvider({ children }: { children: ReactNode }) {
  const [owner, setOwner] = useState<Address>();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE);
      if (saved) setOwner(saved as Address);
    } catch {
      /* ignore */
    }
  }, []);

  const remember = useCallback((address: Address) => {
    setOwner(address);
    try {
      sessionStorage.setItem(STORAGE, address);
    } catch {
      /* ignore */
    }
  }, []);

  /** One passkey ceremony, one action, session always ended. */
  const runOwnerAction = useCallback(
    async <T,>(label: string, fn: (wallet: WalletClient, owner: Address) => Promise<T>) => {
      setBusy(label);
      setError(undefined);
      let end: (() => void) | undefined;
      try {
        const session = await openOwnerSession(owner ? "signIn" : "create", window.location.hostname);
        end = session.end;
        remember(session.account.address);
        const wallet = createWalletClient({ account: session.account, chain, transport: http(RPC_URL) });
        return await fn(wallet, session.account.address);
      } catch (err) {
        setError(explainError(err));
        return undefined;
      } finally {
        end?.();
        setBusy(null);
      }
    },
    [owner, remember],
  );

  const signIn = useCallback(
    async (mode: "create" | "signIn") => {
      setBusy(mode === "create" ? "Creating your account" : "Signing in");
      setError(undefined);
      let end: (() => void) | undefined;
      try {
        const session = await openOwnerSession(mode, window.location.hostname);
        end = session.end;
        const address = session.account.address;
        remember(address);
        // A fresh passkey account holds nothing, so onboarding pre-funds its gas.
        await fetch("/api/fund", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address }),
        }).catch(() => undefined);
        return address;
      } catch (err) {
        setError(explainError(err));
        return undefined;
      } finally {
        end?.();
        setBusy(null);
      }
    },
    [remember],
  );

  const signOut = useCallback(() => {
    setOwner(undefined);
    try {
      sessionStorage.removeItem(STORAGE);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo<Ctx>(
    () => ({ owner, busy, error, clearError: () => setError(undefined), signIn, signOut, runOwnerAction }),
    [owner, busy, error, signIn, signOut, runOwnerAction],
  );

  return <OwnerContext.Provider value={value}>{children}</OwnerContext.Provider>;
}

export function useOwner() {
  const ctx = useContext(OwnerContext);
  if (!ctx) throw new Error("useOwner must be used inside OwnerProvider");
  return ctx;
}

export { clearCredential };
