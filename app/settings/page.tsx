"use client";

/**
 * Account — sign-in method and the passkey behind it.
 *
 * This replaces what used to be a diagnostic checklist. It is framed as account settings,
 * and ceremony failures surface as ordinary product error states with a recovery action
 * rather than as raw error dumps.
 */
import { useCallback, useEffect, useState } from "react";
import { Shell } from "@/components/shell";
import { Button, DataRow, Notice, Panel, StatusBadge, ui as u } from "@/components/ui";
import { AddressLink, pieces as p } from "@/components/pieces";
import { DERIVATION_PATH, clearCredential, loadCredential } from "@/lib/mera";
import { fmtUsd, loadOwnerFunds } from "@/lib/chain";
import { useOwner } from "@/lib/owner-context";
import { formatEther } from "viem";

export default function SettingsPage() {
  const { owner, signIn, signOut, busy, error, clearError } = useOwner();
  const [credential, setCredential] = useState<{ credentialId: string } | null>(null);
  const [funds, setFunds] = useState<{ mon: bigint; usd: bigint; allowance: bigint }>();
  const [secure, setSecure] = useState(true);

  const load = useCallback(async () => {
    if (owner) setFunds(await loadOwnerFunds(owner).catch(() => undefined));
  }, [owner]);

  useEffect(() => {
    setCredential(loadCredential());
    setSecure(window.isSecureContext && typeof window.PublicKeyCredential !== "undefined");
    void load();
  }, [load]);

  return (
    <Shell title="Account" subtitle="Your account is derived from a passkey on this device. There is no password and no seed phrase.">
      <div className={p.stack}>
        {!secure && (
          <Notice tone="error" title="Passkeys need a secure connection">
            Open this page over HTTPS, or on localhost, and the sign-in options will appear.
          </Notice>
        )}

        {error && (
          <Notice tone="error" title="We could not read your account">
            {error}{" "}
            <button
              onClick={clearError}
              className={u.linkBtn}
            >
              Dismiss
            </button>
          </Notice>
        )}

        <Panel title="Sign-in method">
          <DataRow
            label="Method"
            value={
              <span className={u.inlineRow}>
                Passkey {owner ? <StatusBadge kind="active" label="Connected" /> : <StatusBadge kind="expired" label="Not connected" />}
              </span>
            }
          />
          {owner && <DataRow label="Account" value={<AddressLink address={owner} />} />}
          {credential && (
            <DataRow
              label="Passkey on file"
              value={<span className={u.cellMono}>{credential.credentialId.slice(0, 18)}…</span>}
              mono
            />
          )}
          <DataRow label="Derivation" value={DERIVATION_PATH} mono />

          <div className={`${p.btnRow} ${u.mt4}`}>
            {!owner ? (
              <>
                <Button variant="primary" onClick={() => signIn("signIn")} disabled={!!busy || !secure}>
                  {busy ?? "Sign in"}
                </Button>
                <Button onClick={() => signIn("create")} disabled={!!busy || !secure}>
                  Create a new account
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={signOut}>
                Sign out
              </Button>
            )}
            {credential && (
              <Button
                variant="ghost"
                onClick={() => {
                  clearCredential();
                  setCredential(null);
                }}
                disabled={!!busy}
              >
                Forget this passkey
              </Button>
            )}
          </div>
        </Panel>

        {owner && funds && (
          <Panel title="Funding" note="Cards settle in AUSD, a real dollar stablecoin on Monad Testnet.">
            <DataRow label="Gas" value={`${Number(formatEther(funds.mon)).toFixed(3)} MON`} />
            <DataRow label="AUSD balance" value={fmtUsd(funds.usd)} />
            <DataRow
              label="Approved to SpendGate"
              value={funds.allowance > 0n ? `${fmtUsd(funds.allowance)} — bounded on purpose` : "none yet"}
            />
          </Panel>
        )}

        <Panel title="How this works">
          <p className={u.lead}>
            Your passkey never leaves your device. It is used to derive your account key in this
            browser, once per action, and the key is discarded as soon as the action completes — so
            no long-lived signer sits in the page between clicks.
          </p>
          <p className={u.leadTight}>
            Passkeys are tied to the website that created them. A passkey made here will not work on
            a different domain, and the only way to move an account is the recovery phrase behind it.
          </p>
        </Panel>

        <Panel title="Need a different passkey provider?">
          <p className={u.leadTight}>
            AgentCard needs a provider that supports the WebAuthn PRF extension: iCloud Keychain,
            1Password, or Google Password Manager. Passkeys saved only to a desktop Chrome profile
            cannot derive an account, and sign-in will tell you so.
          </p>
        </Panel>
      </div>
    </Shell>
  );
}
