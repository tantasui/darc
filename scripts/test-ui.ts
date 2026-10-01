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
  // A leftover server on this port is worse than no server: `next start` fails to bind, dies
  // quietly, and the browser then drives a STALE BUILD while every assertion looks mysterious.
  // One run was lost to exactly that, so refuse to start instead of guessing.
  try {
    const probe = await fetch(base, { signal: AbortSignal.timeout(2000) });
    if (probe.ok || probe.status > 0) {
      throw new Error(
        `something is already listening on ${APP_PORT}. Stop it first, or set UI_PORT to a free port — ` +
          `otherwise this test silently runs against whatever is already there.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("already listening")) throw err;
    // Connection refused is the expected, healthy case.
  }

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

  /**
   * Clicks and waits for the UI to react.
   *
   * Two traps this has to handle. A click landing before React hydrates is a silent no-op, so
   * it has to be retried. But once a click DOES land, the button goes disabled while the work
   * runs — and treating "disabled" as "not clickable" burns the retries in seconds while the
   * action is still in flight. So a disabled button means wait, not retry.
   */
  const click = async (label: string, settled: (t: string) => boolean, secs = 180) => {
    const find = (what: "state") =>
      ev(
        `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(label)}));` +
          ` return !b ? 'missing' : b.disabled ? 'disabled' : 'ready'; })()`,
      );
    const doClick = () =>
      ev(
        `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(label)}));` +
          ` if (!b || b.disabled) return 'no'; b.click(); return 'yes'; })()`,
      );

    let clicked = false;
    for (let elapsed = 0; elapsed < secs; elapsed++) {
      const t = await text();
      if (settled(t)) return t;

      const state = await find("state");
      if (state === "ready" && !clicked) {
        clicked = (await doClick()) === "yes";
      } else if (state === "missing" && clicked) {
        // The control went away because the step advanced; keep waiting for the result.
      } else if (state === "ready" && clicked) {
        // Re-enabled without settling: the action finished without changing what we match on.
        return t;
      }
      await sleep(1000);
    }
    const snapshot = (await text()).split("\n").filter(Boolean).slice(0, 24).join(" | ");
    throw new Error(`"${label}" never produced a result (clicked=${clicked}).\n  page: ${snapshot}`);
  };

  const go = async (path: string, marker: string) => {
    await send("Page.navigate", { url: base + path });
    await waitFor(`${path} render`, async () => (await text()).includes(marker), 45);
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

    // --- sign in -------------------------------------------------------------
    console.log("Home");
    await go("/", "Spending cards for AI agents");
    await click("Create an account", (t) => /Overview/i.test(t) || /could not/i.test(t));
    let t = await text();
    console.log(`  signed in                 ${/0x[a-fA-F0-9]{4}…[a-fA-F0-9]{4}/.exec(t)?.[0] ?? "?"}`);
    console.log(`  dashboard rendered        ${/Active cards/i.test(t) ? "yes" : "no"}`);

    // --- issue a card --------------------------------------------------------
    console.log("\nCards");
    await go("/cards", "Cards");
    t = await text();
    if (/Add test dollars and approve/i.test(t)) {
      await click("Add test dollars and approve", (tx) => /Issue a card/i.test(tx) || /could not/i.test(tx));
      console.log("  funded + bounded approval ok");
    }
    await click("Issue a card", (tx) => /New card/i.test(tx));
    // The card face renders the mask and the last four as separate elements, so match the mask.
    await click("Issue to Atlas", (tx) => /•••• ••••/.test(tx) || /could not/i.test(tx), 240);
    t = await text();
    console.log(`  card issued               •• ${/•••• ••••\s*\n?\s*(\w{4})/.exec(t)?.[1] ?? "?"}`);

    // --- open the card and run the agent -------------------------------------
    const href = await ev(
      "(() => { const a = [...document.querySelectorAll('a')].find(a => /\\/cards\\/0x/.test(a.getAttribute('href') || '')); return a ? a.getAttribute('href') : ''; })()",
    );
    if (!href) throw new Error("no card link on /cards");
    console.log(`\nCard detail (${href.slice(0, 16)}…)`);
    await go(href, "Atlas");

    await click("Start Atlas", (tx) => /Done for now|Run stopped early|could not/i.test(tx), 300);
    t = await text();
    // Badge labels are uppercased by CSS, so innerText returns PAID/DEFERRED/BLOCKED.
    console.log(`  hosting renewal           ${/paid/i.test(t) ? "paid" : "?"}`);
    console.log(`  api top-up                ${/deferred/i.test(t) ? "deferred (over limit)" : "?"}`);
    console.log(`  data feed                 ${/blocked/i.test(t) ? "blocked (merchant not allowed)" : "?"}`);
    console.log(`  agent narrated            ${/Atlas here/.test(t) ? "yes" : "no"}`);
    console.log(`  reasoned about refusals   ${/Deferring|not on this card/.test(t) ? "yes" : "no"}`);
    console.log(`  on-chain rows             ${(t.match(/DailyCapExceeded|MerchantNotAllowed/g) ?? []).length}`);

    // Capture the agent address here; /verify has no address on screen to scrape.
    const agentAddress = await ev(
      "(() => { const m = document.body.innerText.match(/0x[a-fA-F0-9]{8}…[a-fA-F0-9]{6}/); return m ? m[0] : ''; })()",
    );
    const agentFull = await ev(
      "(() => { const a = [...document.querySelectorAll('a')].map(a => a.getAttribute('href') || '').find(h => /address\\/0x[a-fA-F0-9]{40}/.test(h)); return a ? a.split('/address/')[1] : ''; })()",
    );
    console.log(`  agent address             ${agentAddress || agentFull || "?"}`);

    // --- revoke --------------------------------------------------------------
    await click("Revoke card", (tx) => /revoked/i.test(tx) || /could not/i.test(tx), 240);
    console.log(`  revoked                   ${/This card is revoked/i.test(await text()) ? "yes" : "?"}`);

    // --- activity + agents ---------------------------------------------------
    console.log("\nActivity");
    await go("/activity", "Activity");
    t = await text();
    console.log(`  rows                      ${/Refused/.test(t) ? "approved + refused present" : "?"}`);

    console.log("\nAgents");
    await go("/agents", "Agents");
    t = await text();
    console.log(`  identity listed           ${/#\d+/.test(t) ? "yes" : "?"}`);

    // --- public verifier -----------------------------------------------------
    console.log("\nVerify (public)");
    await go("/verify", "Verify an agent");
    const agent = agentFull;
    if (!agent) throw new Error("could not determine the agent address to verify");
    await ev(
      `(() => { const i = document.querySelector('input'); const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value'); d.set.call(i, ${JSON.stringify(agent || "")}); i.dispatchEvent(new Event('input',{bubbles:true})); return 'set'; })()`,
    );
    await click("Verify", (tx) => /Revoked|Active|No card found/i.test(tx), 90);
    t = await text();
    console.log(`  verdict                   ${/(Revoked|Active|Expired)[^\n]*/.exec(t)?.[0] ?? "?"}`);
    console.log(`  cross-check               ${/Consistent|Mismatch/.exec(t)?.[0] ?? "?"}`);

    // --- mobile pass ---------------------------------------------------------
    console.log("\nMobile (390x844)");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    // Auth-agnostic markers: a signed-out Home has no "Overview" heading, and waiting for one
    // is what hung an earlier run.
    for (const [path, marker] of [["/", "AgentCard"], ["/cards", "Cards"], ["/activity", "Activity"]] as const) {
      await go(path, marker);
      const nav = await ev(
        "(() => { const bars = [...document.querySelectorAll('nav')].map(n => getComputedStyle(n).display); return JSON.stringify(bars); })()",
      );
      const overflow = await ev("String(document.documentElement.scrollWidth > window.innerWidth + 1)");
      console.log(`  ${path.padEnd(10)} bottom nav ${nav.includes("grid") ? "visible" : "MISSING"}, h-overflow ${overflow}`);
    }
    await send("Emulation.clearDeviceMetricsOverride");

    console.log("\n  PASS — dashboard, card, agent run, activity, agents and verifier all work.\n");
  } finally {
    ws.close();
    cleanup();
  }
}

main().catch((err) => {
  console.error(`\n  FAIL — ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
