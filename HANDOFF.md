# AgentCard — handoff context

**As of 1 October 2026 · deadline 14 October (13 days) · 8 commits · working tree clean**

Hand this to a fresh session. It covers what exists, what is proven, and the one thing that still
needs fixing.

---

## What AgentCard is

Trust infrastructure for agentic payments on Monad Testnet, for a hackathon's "Trust, Identity & AI
Infrastructure" track. The thesis: **agents never hold the user's keys — they hold scoped,
revocable, policy-bound delegated keys, presented as a "card."**

The user's root of trust is a passkey. Issuing a card generates a fresh agent keypair, registers the
agent under ERC-8004, and writes a spending policy on-chain under the user's authority. Every spend
is verified against the whole chain, and **every attempt — approved or refused — becomes public
on-chain data.** The refusals are the novel part: anyone can show successes.

---

## Status: feature-complete and tested end to end

**Tested by the user on 1 October 2026. The full flow works in a real browser against the live
deployment.** Nothing below is aspirational.

| Area | State |
|---|---|
| Contracts | 62 tests passing, 2 skipped (they need deployed addresses passed in) |
| Deployed | Live on Monad Testnet, all 7 contracts Sourcify-verified `exact_match` |
| ERC-8004 | Integrated with the **canonical** registries, verified on-chain |
| Declines on-chain | Working, with the reason readable by `eth_call` |
| Passkey → EOA → tx | Proven, including the WebAuthn ceremony |
| `/console` `/demo` `/verify` `/mera` | All four built and driven end to end |

One automated run of `npm run test:ui` produces:

```
/console  passkey account created, pre-funded, $1000 + $500 bounded approval
          card issued  Card •• A55A  $50/day  ERC-8004 id 1949
/demo     $20 approved | $200 declined DailyCapExceeded
          merchant B declined MerchantNotAllowed | $30 of $50 left
/console  REVOKED
/demo     next attempt declined CardRevoked
/verify   REVOKED — do not transact, cross-check consistent
```

### Deployed addresses (Monad Testnet, chain 10143)

| Contract | Address |
|---|---|
| CardManager | `0xA00d6901676EA65D3Fc0920046877eB8505329B0` |
| SpendGate | `0x0dD6F49781Cca0D309F784209d3f2Dc5Ec1ac26e` |
| SpendRouter | `0x2d6C43F8D74501af8A386589137980F729a43cA1` |
| ReputationReader | `0x07885e31E2d1291583d6c4fed220C970e1AE0247` |
| MockUSD | `0x82acf5f99EA05e5BD6a1886B5cBA63dE1Fc15395` |
| MockMerchant A / B | `0x10AC2e0abEB38e24dE19Fc5d2e2DcA5D9EEeF14E` / `0xBf7B5E80045Ed9408B02297ccd707b1e61901A1A` |
| ERC-8004 Identity (not ours) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation (not ours) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

---

## THE OPEN CONCERN — read this first

**The user's words: it does not look like a product people would use. It looks like someone
learning a new technology.** That judgement is correct, and it is now the main remaining work.

The engineering is sound and defensible. The *presentation* is not. Specifically:

### Why it reads as a learning exercise

1. **No design language.** Every page is inline `style={{...}}` objects with ad-hoc hex colours
   (`#12161c`, `#4f7cff`, `#9aa3b2`) repeated across four files. No tokens, no spacing scale, no
   typography system, no component library. Panels, buttons and rows are redefined per page.
2. **It reads like a test harness, because it partly is.** `/mera` is literally a diagnostic
   checklist with ○ ◍ ● ✕ marks. `/demo` is numbered buttons ("1. Issue a card", "2. Buy $20 at A")
   that walk a judge through a script rather than letting a user do a task.
3. **Everything is visibly mock.** `MockUSD`, `MockMerchant A`, `MockMerchant B`, "test dollars".
   The merchant names are placeholders, so the product has no apparent domain.
4. **The card is not a card.** "Card •• A55A" is text in a bordered box. The pitch is a *card*
   metaphor; nothing in the UI earns it.
5. **No states beyond happy and error.** No empty states, skeletons, optimistic updates, or
   transitions. Actions block the whole page with "Working…".
6. **No product shell.** No nav between the four surfaces (only the home page links out), no
   header, no identity, no name treatment, no favicon, no mobile layout work. The demo is supposed
   to run on a phone-sized viewport and that has never been checked.
7. **No agent.** The "agent" is a button. There is no LLM, no MCP, nothing autonomous, so the
   central claim — *agentic* payments — is asserted rather than shown.
8. **Single card, single user.** No card list, no history, no spend feed, no multiple cards, no
   per-merchant breakdown. Real usage implies managing several cards over time.

### What would move it from "demo" to "product"

Highest leverage first, assuming ~13 days:

1. **A design pass with real tokens** (colour, spacing, type scale), extracted into shared
   components. This single change does the most for perceived quality. Four pages, ~1,500 lines of
   JSX — mechanical, low-risk work.
2. **Make the card look like a card.** Gradient, last-4, limit, merchant count, status, issuer
   mark. It is the product's one memorable image and belongs on the landing page.
3. **Give the merchants an identity.** Rename to something concrete (a coffee shop and a cloud
   host, say) so "scoped to merchants" means something. Contract-side this is only constructor
   args and a redeploy, which is already scripted.
4. **A real agent loop.** Even a small one: a scripted "shopping assistant" that decides what to
   buy and gets refused. The honest alternative is to say plainly that Phase 1 has no LLM.
5. **A product shell**: persistent nav, name, favicon, a real landing page, and a mobile pass.
6. **Activity feed** on the console: one list of attempts with reasons, instead of a log that only
   exists during the current session.
7. **Demote `/mera`.** It is a diagnostic. Move it behind a `/debug` path so the product surface
   is three pages, not four.

### What NOT to touch

The contracts, the tests, the ERC-8004 integration, the declines-on-chain pattern and the deployed
addresses are all working and verified. Design work should not require a contract change, with the
single exception of renaming the demo merchants (item 3), which is a redeploy of the mocks only.

---

## Architecture, in brief

- **Owner key:** derived from a passkey via Mera — WebAuthn PRF → BIP-39 → BIP-32 at
  `m/44'/60'/0'/0/0` → a plain secp256k1 EOA. **Mera does not derive keys itself; that step is ours
  in `lib/mera.ts`.** The passkey is the derivation root and recovery mechanism, *not* an on-chain
  signer. Prompt-per-transaction: every owner action runs its own ceremony and ends the session in a
  `finally` block.
- **Agent key:** fresh, random, per card. Never derived from the passkey, so it is independently
  revocable and disposable.
- **Policy:** stored on-chain in `CardManager` (cap, merchant Merkle root, expiry, `policyVersion`),
  written by an owner-signed transaction. Chosen over off-chain certificates so revocation is atomic.
- **Enforcement:** `SpendGate.spend` runs ten checks, each with its own custom error. The agent only
  ever signs an EIP-712 `SpendAuth`; a relayer submits and pays gas.
- **Declines:** `SpendRouter` calls the gate inside `try/catch`, so the spend unwinds but the router's
  frame survives to emit `SpendDeclined`. The reason is **also** written into the ERC-8004
  attestation, because public Monad RPCs cap `eth_getLogs` at 100 blocks — a verifier built on events
  could not read history at all.
- **Reputation:** written by **merchants**, not us. The canonical registry rejects feedback from
  whoever owns the agent's identity, and `CardManager` owns it. Enforced by the registry, not by our
  good intentions.

## Decisions already made (do not re-litigate)

- `policyVersion` is inside the signed `SpendAuth`. Without it the field is inert and cannot expire
  stale authorizations. This corrected a bug in the original spec.
- `amount` over a **single pinned token**, not `amountUSD` over arbitrary tokens: a USD cap cannot
  bound an arbitrary token without a price oracle. Multi-token caps are deferred, with reasoning.
- Nonces are an **order-independent used-set**, not a monotonic counter, which would strand
  authorizations that arrive late under a relayer.
- **No un-revoke.** A new card is a new issuance, and agent keys are permanently consumed.
- Owner approval to SpendGate is **bounded**. Unbounded would sit upstream of every policy.
- Privy and Pimlico were dropped: Mera supplies the account and the auth, and a plain EOA has nothing
  for a 4337 bundler to bundle.

## Known caveats, all documented

- **Agent key custody is demo-only** — generated in the browser, held in `localStorage`. Survivable
  only because the key is capped, merchant-scoped, expiring and instantly revocable: a stolen agent
  key is a bounded loss by design.
- **`/demo`'s API routes hold a stand-in owner key server-side** and are unauthenticated. That keeps
  the demo clickable without a prompt per step; it is not the product. `/console` is the real flow.
- **ERC-8004 registries are UUPS-upgradeable** under a third-party key
  (`0x547289319C3e6aedB179C0b8e8aF0B5ACd062603`, matching the project's published deployer). Accepted:
  every integrator on this chain shares it.
- **Passkeys bind to their domain (`rpId`).** A passkey made on `localhost` is unreachable from a
  deployed domain. **Create the demo passkey on the domain you present from.**
- Monad's own ERC-8004 guide publishes **mainnet** registry addresses that have no code on testnet.
  A test pins this so nobody reintroduces them.

## Operational gotchas

- **`npm run dev` fails on this machine** with `OS file watch limit reached` (65,536 watches, and
  most inotify instances already used). It surfaces confusingly as
  `Can't resolve '../../i18n/normalize-locale-path'`. Use `npm run build && npm run start`, or raise
  the limit: `sudo sysctl fs.inotify.max_user_watches=524288`.
- **Gas is low.** Funder `0x699335Eb79627308514349ac224c2697CED33073` ≈ 0.66 MON, relayer ≈ 0.42 MON.
  One full click-through costs roughly a dozen transactions. Faucet the funder, then `npm run fund`.
- Secrets live in `.env` (gitignored): deployer, funder, demo owner, relayer. Testnet only.
- `innerText` reflects CSS, so a heading styled `text-transform: uppercase` comes back uppercased —
  this broke the UI test twice. And a click before React hydrates is a silent no-op.

## Commands

```bash
cd contracts && forge test            # 62 passing
npm run build && npm run start        # the app (do not use npm run dev here)
npm run test:ui                       # drives console → demo → verify in headless Chrome
npm run test:passkey                  # the WebAuthn ceremony, virtual authenticator
npm run mera:check:onchain            # passkey → EOA → real transaction
npm run demo                          # the whole demo as real transactions, no UI
npm run fund:check                    # balances before presenting
```

Full detail: [README.md](README.md) for design reasoning, [TESTING.md](TESTING.md) for the testing
layers, [DEPLOY.md](DEPLOY.md) for the deploy runbook.
