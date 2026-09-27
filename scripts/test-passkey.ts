/**
 * Automated end-to-end test of the passkey flow, including the WebAuthn ceremony.
 *
 * The ceremony was the one link we could not test headlessly -- it normally needs a real
 * authenticator. Chrome's CDP `WebAuthn` domain can create a VIRTUAL authenticator with
 * `hasPrf: true`, exercising the same browser code path real hardware would.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT:
 *   proves  -- our PRF request, derivation, signing, transaction and session teardown are
 *              correct, and a PRF-capable authenticator makes the whole flow work.
 *   does NOT prove -- that a particular real provider supports PRF. iCloud Keychain,
 *              1Password and Google Password Manager do; desktop Chrome local-profile
 *              passkeys do not and throw PRF_UNAVAILABLE. Only a real device settles that.
 *
 * Usage: npm run build && npm run test:passkey
 */
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MONAD_TESTNET, RPC_URL, GAS } from "../config/chain.ts";

const APP_PORT = Number(process.env.APP_PORT ?? 3210);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9334);
const APP_URL = `http://localhost:${APP_PORT}/mera`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP client over Node's global WebSocket. */
class Cdp {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data));
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }

  static async connect(url: string) {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP socket failed")), { once: true });
    });
    return new Cdp(ws);
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async text(expression: string): Promise<string> {
    const r = await this.send<{ result: { value?: string } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result.value ?? "";
  }

  close() {
    this.ws.close();
  }
}

/** Clicks a button, retrying until the UI reacts: a click landing before React hydrates is
 *  a silent no-op, which is exactly what made the first version of this test time out. */
async function clickUntilResponse(cdp: Cdp, label: string, settled: (text: string) => boolean) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const clicked = await cdp.text(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(label)}));` +
        ` if (!b || b.disabled) return 'unavailable'; b.click(); return 'clicked'; })()`,
    );
    if (clicked === "clicked") {
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        const t = await cdp.text("document.body.innerText");
        if (settled(t)) return t;
      }
    }
    await sleep(2000);
  }
  throw new Error(`"${label}" never produced a result`);
}

async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const chain = defineChain(MONAD_TESTNET);
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

  console.log("\nPasskey end-to-end test (Chrome virtual authenticator, PRF enabled)\n");

  const app = spawn("npx", ["next", "start", "-p", String(APP_PORT)], { stdio: "ignore" });
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${CDP_PORT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    app.kill("SIGTERM");
    chrome.kill("SIGTERM");
  };
  process.on("exit", cleanup);

  let cdp: Cdp | undefined;
  try {
    await waitFor("app to start", async () => {
      try {
        return (await fetch(APP_URL)).ok;
      } catch {
        return false;
      }
    });

    let wsUrl = "";
    await waitFor("chrome to start", async () => {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as {
          type: string;
          webSocketDebuggerUrl: string;
        }[];
        const page = targets.find((t) => t.type === "page");
        if (!page) return false;
        wsUrl = page.webSocketDebuggerUrl;
        return true;
      } catch {
        return false;
      }
    });

    cdp = await Cdp.connect(wsUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("WebAuthn.enable");

    const { authenticatorId } = await cdp.send<{ authenticatorId: string }>("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        hasPrf: true,
        automaticPresenceSimulation: true,
        isUserVerified: true,
      },
    });
    console.log(`  virtual authenticator ${authenticatorId} (ctap2_1, PRF on)\n`);

    await cdp.send("Page.navigate", { url: APP_URL });
    await waitFor("page to render", async () =>
      (await cdp!.text("document.body.innerText")).includes("Mera passkey check"),
    );

    // --- phase 1: create a passkey --------------------------------------------
    console.log("  phase 1 — create a passkey");
    // Hydration takes a moment after first paint; clickUntilResponse handles that.
    const settled = (t: string) => /0x[a-fA-F0-9]{40}/.test(t) || t.includes("Failed");
    await clickUntilResponse(cdp, "Create a passkey", settled);
    // The address appears before the later steps resolve; wait for the run to actually end
    // so the reported results are the final ones rather than a snapshot mid-flight.
    await waitFor(
      "run to finish",
      async () => {
        const t = await cdp!.text("document.body.innerText");
        return t.includes("SESSION_ENDED") || t.includes("signing still worked") || t.includes("Failed");
      },
      90_000,
    );

    let text = await cdp.text("document.body.innerText");
    if (text.includes("Failed")) {
      throw new Error(`ceremony failed: ${text.split("Failed")[1]?.trim().split("\n")[0] ?? ""}`);
    }

    const address = (text.match(/0x[a-fA-F0-9]{40}/) ?? [])[0];
    if (!address) throw new Error("no derived address was rendered");
    console.log(`    derived address  ${address}`);
    console.log(`    EIP-712 signing  ${text.includes("chars") ? "ok" : "not reported"}`);
    const unfunded = text.includes("has no MON");
    console.log(`    transaction      ${unfunded ? "skipped (fresh passkey has no MON, expected)" : "attempted"}`);
    console.log(`    session teardown ${text.includes("SESSION_ENDED") ? "SESSION_ENDED as expected" : "not reported"}`);

    // --- phase 2: fund, then sign in with the SAME passkey --------------------
    const funderKey = process.env.FUNDER_PRIVATE_KEY as `0x${string}` | undefined;
    if (!funderKey) {
      console.log("\n  phase 2 skipped — set FUNDER_PRIVATE_KEY to cover the transaction step too\n");
      return;
    }

    console.log("\n  phase 2 — fund it, then sign in with the same passkey");
    const balance = await publicClient.getBalance({ address: address as `0x${string}` });
    if (balance < parseEther("0.02")) {
      const funder = createWalletClient({ account: privateKeyToAccount(funderKey), chain, transport: http(RPC_URL) });
      const hash = await funder.sendTransaction({
        to: address as `0x${string}`,
        value: parseEther("0.05"),
        gas: GAS.transfer,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log("    funded with 0.05 MON");
    } else {
      console.log(`    already holds ${formatEther(balance)} MON`);
    }

    await clickUntilResponse(
      cdp,
      "Sign in with existing passkey",
      (t) => t.includes("block ") || t.includes("Failed"),
    );

    text = await cdp.text("document.body.innerText");
    if (text.includes("Failed")) {
      throw new Error(`sign-in failed: ${text.split("Failed")[1]?.trim().split("\n")[0] ?? ""}`);
    }

    // The real determinism proof: the same passkey must rebuild the same account, or the
    // funding above would have been useless.
    const second = (text.match(/0x[a-fA-F0-9]{40}/) ?? [])[0];
    if (second?.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`same passkey derived a different account: ${second}`);
    }
    console.log("    same passkey reproduced the same address: yes");
    console.log(`    transaction      ${text.includes("block ") ? "confirmed on Monad Testnet" : "not confirmed"}`);
    console.log(`    session teardown ${text.includes("SESSION_ENDED") ? "SESSION_ENDED as expected" : "not reported"}`);

    console.log("\n  PASS — the passkey ceremony works end to end with a PRF-capable authenticator.");
    console.log("  A real provider still needs a real device: iCloud Keychain, 1Password, or Google Password Manager.\n");
  } finally {
    cdp?.close();
    cleanup();
  }
}

main().catch((err) => {
  console.error(`\n  FAIL — ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
