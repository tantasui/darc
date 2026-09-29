# How to test AgentCard

Eight layers, seven of them automated. Run them in this order; each one assumes the ones above it pass.

```bash
cd contracts && forge test        # 1-3: contracts, live registries, cross-language constants
cd .. && npm run mera:check       # 4: passkey derivation, offline
npm run mera:check:onchain        # 5: same, plus a real transaction
npm run build && npm run test:passkey   # 6: the WebAuthn ceremony itself
npm run demo                      # 7: the whole demo, live on testnet
```

Anything needing gas reads `FUNDER_PRIVATE_KEY` from `.env`. Check funds first with `npm run fund:check`.

---

## 1. Contracts — `forge test`

**62 passing, 2 skipped.** The 2 skip until you pass deployed addresses (layer 8).

| Suite | Count | What it pins |
|---|---|---|
| `SpendGate.t.sol` | 23 | Full-chain approval, all 10 decline reasons, replay, deadline, Merkle proofs, cap boundary, UTC day rollover, revocation |
| `CardManager.t.sol` | 15 | Issuance, access control, terminal revocation, policy versioning, `bindAgentWallet` |
| `ReputationTrail.t.sol` | 12 | Declines on-chain, no state left behind, merchant attestation, reason stored in the attestation, reader reports |
| `DemoScript.t.sol` | 3 | The 90-second demo as a test, plus fuzzed cap and signature invariants |
| `MonadForkIntegration.t.sol` | 6 | The flow against the **real** ERC-8004 registries on chain 10143 |
| `CrossLanguageConstants.t.sol` | 3 | EIP-712 typehash, Merkle leaf encoding, all 10 decline selectors |

Two of these earn their keep specifically:

**The fork suite** is what stops the mocks from flattering us. It proved the load-bearing design
claim on the real contract — a merchant can rate an agent, and our own CardManager is rejected with
`"Self-feedback not allowed"`. It also caught a bug that would otherwise have surfaced during deploy
week: `register()` uses `_safeMint`, so `issueCard` reverted until CardManager implemented
`onERC721Received`.

**`CrossLanguageConstants.t.sol`** pins values TypeScript recomputes independently. A mismatch there
would compile, pass tests in each language alone, and fail *only* during a live demo. Writing it
caught two selectors that had been guessed rather than computed.

Offline only (skip the fork suite):

```bash
forge test --no-match-path 'test/MonadForkIntegration.t.sol'
```

## 4-5. Mera derivation — `npm run mera:check[:onchain]`

Proves every link in the passkey chain except the browser ceremony: 32-byte PRF → 24-word mnemonic →
key at `m/44'/60'/0'/0/0` → viem account, that the same PRF reproduces the same address, EIP-191 and
EIP-712 signing, and that signing after `session.end()` is rejected with `SESSION_ENDED`.

With `--onchain` it also funds the derived account and sends a transaction, so the claim "a
passkey-derived account transacts on Monad" is demonstrated rather than asserted.

## 6. The WebAuthn ceremony — `npm run test:passkey`

The ceremony normally needs real hardware. Chrome's CDP `WebAuthn` domain provides a **virtual
authenticator** with `hasPrf: true`, which runs the same browser code path real hardware would.

The test drives the real `/mera` page in headless Chrome:

1. Creates a passkey, then checks the derived address, EIP-712 signature and session teardown.
2. Funds that address, then clicks **sign in with the same passkey** and requires it to reproduce the
   same address — determinism proved through the actual ceremony, not a stand-in value — and to send
   a confirmed transaction.

```
phase 1 — create a passkey
  derived address  0xB23D10DA…99B0
  EIP-712 signing  ok
  transaction      skipped (fresh passkey has no MON, expected)
  session teardown SESSION_ENDED as expected
phase 2 — fund it, then sign in with the same passkey
  same passkey reproduced the same address: yes
  transaction      confirmed on Monad Testnet
```

**What this does not prove:** that a *particular real provider* supports PRF. iCloud Keychain,
1Password and Google Password Manager do; desktop Chrome local-profile passkeys do not and throw
`PRF_UNAVAILABLE`. Only layer 9 settles that.

*Note if you extend this test:* a click that lands before React hydrates is a silent no-op, which is
what made the first version time out. `clickUntilResponse` retries until the UI reacts.

## 6b. The whole product in a browser — `npm run test:ui`

Drives `/console` → `/demo` → `/verify` in headless Chrome against the live deployment, using the
same virtual authenticator for the passkey ceremonies. This is the one that proves the *pages*
work, not just the contracts beneath them: account creation and pre-funding, test dollars and a
bounded approval, issuance, an in-policy purchase, both refusals, revocation from the console, and
the resulting public verdict.

Two traps it already caught, both worth knowing if you extend it:

- **`innerText` reflects CSS.** A heading styled `text-transform: uppercase` comes back as
  `ISSUE A CARD`, so literal matching silently fails. Match case-insensitively.
- **A click before React hydrates is a silent no-op**, so clicks retry until the UI reacts.

Each run costs real testnet gas (roughly a dozen transactions) and permanently consumes one agent
key, which is by design — agent keys are never reusable.

## 7. Live demo — `npm run demo`

Runs the pitch as real transactions: issue → $20 approved → $200 declined `DailyCapExceeded` →
merchant B declined `MerchantNotAllowed` → revoke → retry declined `CardRevoked`. Prints an explorer
link per transaction. Run it once before presenting so the trail already exists.

Confirm it independently rather than trusting the script — this is the check that caught nothing but
would have caught a lot:

```bash
# reasons are stored on the canonical registry, readable by eth_call
cast call 0x8004B663056A597Dffe9eCcC1965A193B7388713 \
  'readAllFeedback(uint256,address[],string,string,bool)(address[],uint64[],int128[],uint8[],string[],string[],bool[])' \
  <agentId> '[<merchantA>,<merchantB>]' "" "" false --rpc-url $MONAD_TESTNET_RPC
```

## 8. Post-deploy smoke test

After any deploy, run the demo against the **deployed** addresses. `forge test` proves the code is
right; this proves the *deployment* is right — it asserts wiring first, so a gate pointing at the
wrong CardManager fails with a clear reason instead of a confusing revert. Commands are in
[DEPLOY.md](DEPLOY.md) step 4.

## The Verifier page

`/verify` needs no wallet and no device, so it is the easiest thing to check by hand — but it can
also be verified headlessly, since it renders live chain data client-side:

```bash
npm run build && npm run start &
google-chrome --headless=new --no-sandbox --virtual-time-budget=25000 \
  --dump-dom http://localhost:3000/verify | grep -E "REVOKED|DailyCapExceeded|consistent"
```

A plain `curl` only returns the server-rendered shell, so it will look empty — use the browser dump.

## 9. The one manual test: a real device

Everything above can run unattended. What cannot: whether a **real passkey provider** supports the
PRF extension.

```bash
npm run dev      # then open http://localhost:3000/mera
```

Use a provider that supports PRF — iCloud Keychain, 1Password, or Google Password Manager. On desktop
Chrome, make sure the passkey is saved to Google Password Manager; a local-profile passkey throws
`PRF_UNAVAILABLE` by design, and the page explains that when it happens.

**Testing from a phone is harder than it looks.** WebAuthn needs a secure context, so
`http://192.168.x.x:3000` will not work — no HTTPS means no WebAuthn at all. Options:

- **Desktop Chrome on this machine with Google Password Manager** — `localhost` counts as secure. Simplest.
- **An HTTPS tunnel** (`cloudflared tunnel --url http://localhost:3000`) to reach a phone. Nothing is
  installed here, so this needs a one-off install.
- **Chrome DevTools → WebAuthn tab**, adding a virtual authenticator by hand — the manual version of
  layer 6.

**Create the demo passkey on the domain you will present from.** Passkeys are bound to their `rpId`,
so a passkey made on `localhost` is unreachable from a deployed domain, and vice versa. Getting this
wrong on stage is unrecoverable in the moment.

### If `next dev` fails with `OS file watch limit reached`

An inotify limit on this machine (currently 65536), not a code problem:

```bash
sudo sysctl fs.inotify.max_user_watches=524288
```

`npm run build && npm run start` needs no watches and is unaffected.

---

## Before demoing

```bash
npm run fund:check    # owner AND relayer above threshold — declines cost the relayer gas too
```

Then: `forge test` green, `npm run demo` once on the live deployment, `/verify` loads the resulting
agent, and the passkey you will use on stage was created on the domain you will present from.
