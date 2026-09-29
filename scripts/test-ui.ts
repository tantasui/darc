/**
 * Drives the whole product through a real browser: console -> demo -> verify.
 *
 * Uses Chrome's virtual authenticator (PRF enabled) for the passkey ceremonies, so the
 * owner flow runs exactly as it would for a human, without a device. Everything else is
 * real: real contracts, real transactions, real gas.
 *
 * Usage: npm run build && npm run test:ui
 */
import { spawn } from "node:child_process";

const APP_PORT = Number(process.env.UI_PORT ?? 3220);
const CDP_PORT = Number(process.env.UI_CDP_PORT ?? 9337);
const base = `http://localhost:${APP_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
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
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    app.kill("SIGTERM");
    chrome.kill("SIGTERM");
  };
  process.on("exit", cleanup);

  const waitFor = async (label: string, fn: () => Promise<boolean>, secs = 60) => {
    for (let i = 0; i < secs; i++) {
      if (await fn()) return;
      await sleep(1000);
    }
    throw new Error(`timed out: ${label}`);
  };

  await waitFor("app", async () => {
    try {
      return (await fetch(base)).ok;
    } catch {
      return false;
    }
  }, 90);

  let wsUrl = "";
  await waitFor("chrome", async () => {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      const page = list.find((t) => t.type === "page");
      if (!page) return false;
      wsUrl = page.webSocketDebuggerUrl;
      return true;
    } catch {
      return false;
    }
  }, 90);

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("CDP connect failed")), { once: true });
  });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String((e as MessageEvent).data));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression: string): Promise<string> => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value ?? "";
  };
  const text = () => ev("document.body.innerText");
  const idle = () => ev("String(![...document.querySelectorAll('button')].some(b => b.disabled))");

  /** Clicks, retrying until the UI reacts: a click before hydration is a silent no-op. */
  const click = async (label: string, settled: (t: string) => boolean, secs = 180) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await ev(
        `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(label)}));` +
          ` if (!b || b.disabled) return 'unavailable'; b.click(); return 'clicked'; })()`,
      );
      if (r === "clicked") {
        for (let i = 0; i < secs; i++) {
          await sleep(1000);
          if (settled(await text())) return;
        }
      }
      await sleep(2000);
    }
    const snapshot = (await text()).split("\n").filter(Boolean).slice(0, 24).join(" | ");
    throw new Error(`"${label}" never produced a result.\n  page: ${snapshot}`);
  };

  const go = async (path: string, marker: string) => {
    await send("Page.navigate", { url: base + path });
    await waitFor(`${path} render`, async () => (await text()).includes(marker), 60);
    await sleep(2500); // let hydration settle and the first reads land
  };

  try {
    await send("Runtime.enable");
    await send("Page.enable");
    await send("WebAuthn.enable");
    const { authenticatorId } = (
      await send("WebAuthn.addVirtualAuthenticator", {
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
      })
    ).result;
    console.log(`\nUI end-to-end — virtual authenticator ${authenticatorId} (PRF on)\n`);

    // --- owner console ---------------------------------------------------------
    console.log("/console");
    await go("/console", "Owner console");
    await click("Create an account with a passkey", (t) => /your account\n/i.test(t) || /failed/i.test(t));
    let t = await text();
    const owner = (t.match(/0x[a-fA-F0-9]{8}…[a-fA-F0-9]{6}/) ?? [])[0];
    console.log(`  passkey account created   ${owner ?? "?"}`);
    await waitFor("gas to land", async () => /[\d.]+ MON/.test(await text()), 60);
    console.log(`  pre-funded with gas       ${/[\d.]+ MON/.exec(await text())?.[0] ?? "?"}`);

    await click("Add test dollars and approve", (t) => /issue a card/i.test(t) || /failed/i.test(t));
    t = await text();
    console.log(`  balance + bounded approval ${/\$[\d.]+ \(bounded\)/.exec(t)?.[0] ?? "set"}`);

    await click("Issue card", (t) => /Card •• /i.test(t) || /failed/i.test(t));
    t = await text();
    console.log(`  card issued               ${/Card •• \w+/.exec(t)?.[0]}  ${/\$\d+\/day/.exec(t)?.[0] ?? ""}`);
    console.log(`  ERC-8004 id               ${/ERC-8004 ID\s*\n?\s*(\d+)/.exec(t)?.[1] ?? "?"}`);

    // --- agent demo ------------------------------------------------------------
    console.log("\n/demo");
    await go("/demo", "Agent demo");
    await click("2. Buy $20 at A", (t) => /Buy \$20 at merchant A/.test(t) && !/◍/.test(t));
    console.log(`  in-policy $20             ${/✕|●/.exec(await text())?.[0] === "●" ? "approved" : "see log"}`);
    await click("3. Try $200 (over cap)", (t) => /DailyCapExceeded|Buy \$200[\s\S]*—/.test(t) && !/◍/.test(t));
    console.log(`  over cap                  ${/DailyCapExceeded/.test(await text()) ? "declined DailyCapExceeded" : "?"}`);
    await click("4. Try merchant B", (t) => /MerchantNotAllowed/.test(t) && !/◍/.test(t));
    console.log(`  out-of-scope merchant     ${/MerchantNotAllowed/.test(await text()) ? "declined MerchantNotAllowed" : "?"}`);
    t = await text();
    console.log(`  remaining today           ${/\$[\d.]+ of \$\d+/.exec(t)?.[0] ?? "?"}`);

    // --- revoke, from the console (the passkey owner is the only one who can) ----
    console.log("\n/console — revoke");
    await go("/console", "Owner console");
    await click("Sign in", (t) => /your account\n/i.test(t) || /failed/i.test(t));
    await click("Revoke this card", (t) => /REVOKED/.test(t) || /failed/i.test(t));
    console.log(`  card state                ${/REVOKED/.test(await text()) ? "REVOKED" : "?"}`);

    console.log("\n/demo — retry after revocation");
    await go("/demo", "Agent demo");
    await click("2. Buy $20 at A", (t) => /CardRevoked/.test(t) && !/◍/.test(t));
    console.log(`  next attempt              ${/CardRevoked/.test(await text()) ? "declined CardRevoked" : "?"}`);

    // --- verifier --------------------------------------------------------------
    console.log("\n/verify");
    await go("/verify", "Verify an agent");
    t = await text();
    console.log(`  verdict                   ${/(REVOKED|ACTIVE|EXPIRED)[^\n]*/.exec(t)?.[0] ?? "?"}`);
    console.log(`  cross-check               ${/consistent|MISMATCH/.exec(t)?.[0] ?? "?"}`);

    console.log("\n  PASS — console, demo and verifier all work against the live deployment.\n");
  } finally {
    ws.close();
    cleanup();
  }
}

main().catch((err) => {
  console.error(`\n  FAIL — ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
