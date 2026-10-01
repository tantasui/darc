# AgentCard — handoff context

**As of 1 October 2026 · deadline 14 October (13 days) · 13 commits**

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
| `/` `/cards` `/activity` `/agents` `/verify` `/settings` | Built on one design system, driven end to end |
| Settlement token | Real AUSD, not a mock |

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

Regenerate with `npm run write-config`; never hand-copy.

| Contract | Address |
|---|---|
| CardManager | `0xBE65B96d591840AaCBe591B327abe92Cddc64D24` |
| SpendGate | `0xE020378b873d10dB86f3a1FF5c781db58B034794` |
| SpendRouter | `0xFc5Eb559b062F48D8f5C7d04F01C07568eB43124` |
| ReputationReader | `0xc86630cB8901ff7038e2Fa3b48C3b2E4d28e159e` |
| Lagos Cloud Hosting | `0xdaf1f3fdc83e49BD4D50fDA1613c15D1C7552244` |
| Horizon Data API | `0x51fA5af542179cDe11e517b377f7fc2e443D86e8` |
| Riverside Subscriptions | `0x0B0DFdc99265ACead416F9872B283EDD0D33b87A` |
| AUSD (settlement, Agora's) | `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` |
| AUSD faucet (Agora's) | `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C` |
| ERC-8004 Identity (not ours) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ERC-8004 Reputation (not ours) | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

---

## Phase 5 closed the product-polish gap

The previous concern — *it looks like someone learning a new technology, not a product people
would use* — has been addressed. What changed:

1. **A design system.** Tokens in `app/globals.css` (one palette, one spacing scale, one type
   scale) and primitives in `components/ui`. Inline styles went from 57 to 2, and both survivors
   are parameterised component props, not styling decisions. Status tones and merchant tints are
   classes, so nothing computes a colour inline.
2. **A product shell.** Left rail on desktop, bottom bar on phones, account block with sign-out,
   a wordmark and favicon. Seven screens: Home, Cards, card detail, Activity, Agents, Verify,
   Account.
3. **The card looks like a card.** ISO aspect ratio, chip, masked number; revoked cards
   desaturate and get a struck-through overprint, so state is visible on the face.
4. **Real money.** Cards settle in **AUSD**, Agora's dollar stablecoin on Monad Testnet
   (`0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`), not a token we minted. Six decimals, which is
   why the single-pinned-token design already fit. The faucet's ABI is unpublished; the working
   call, `requestFunds(address)`, was recovered from its proxy implementation's bytecode.
5. **Real merchants.** Lagos Cloud Hosting, Horizon Data API, Riverside Subscriptions — names
   stored on-chain. Two inside a typical policy, one outside it.
6. **An agent that decides.** Atlas holds three goals, picks its own amount and merchant, and
   branches on *why* it was refused (defer over cap, block out-of-scope, halt on revoked), with a
   transcript narrating the reasoning. Deterministic, no LLM.
7. **`/mera` is gone** as a product surface; it is now `/settings`, framed as account settings.

### What would still read as unfinished to a critical eye

- **Custody is still demo-grade.** Agent private keys live in `localStorage`. This is the honest
  weak point, and it is survivable only because a key is capped, merchant-scoped, expiring and
  instantly revocable.
- **One card per browser, effectively.** `lib/cards.ts` remembers cards locally because
  CardManager keys them by `keccak(owner, agentKey)` and `eth_getLogs` is capped at 100 blocks, so
  there is no on-chain way to enumerate an owner's cards. Signing in on another device shows
  nothing.
- **Activity amounts and timestamps come from the browser.** The on-chain attestations carry only
  verdict and reason, because the registry stores two tag strings per entry. The UI says so.
- **No notifications, no multi-user, no real merchant SDK**, and the agent is still a scripted
  loop rather than a model making calls.

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
- **Gas.** Funder `0x699335Eb79627308514349ac224c2697CED33073`; `npm run fund` spreads it to the
  owner and relayer, `npm run fund:check` prints the table. One full click-through costs roughly a
  dozen transactions, so check before demoing.
- **AUSD, not gas.** The owner also needs AUSD to back a card. `/cards` claims it from Agora's
  faucet (10,000 AUSD, short cooldown) as part of the one-time setup.
- Secrets live in `.env` (gitignored): deployer, funder, demo owner, relayer. Testnet only.
- `innerText` reflects CSS, so anything styled `text-transform: uppercase` (headings, status
  badges) comes back uppercased — this broke the UI test twice. A click before React hydrates is a
  silent no-op. And never pipe a long background run through `tail`: the output buffers until the
  process ends, which hides all progress.

## Commands

```bash
cd contracts && forge test            # 62 passing
npm run build && npm run start        # the app (do not use npm run dev here)
npm run test:ui                       # drives the whole product in headless Chrome, incl. mobile
npm run test:passkey                  # the WebAuthn ceremony, virtual authenticator
npm run mera:check:onchain            # passkey → EOA → real transaction
npm run demo                          # the whole demo as real transactions, no UI
npm run fund:check                    # balances before presenting
```

Full detail: [README.md](README.md) for design reasoning, [TESTING.md](TESTING.md) for the testing
layers, [DEPLOY.md](DEPLOY.md) for the deploy runbook.
