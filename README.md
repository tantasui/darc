# AgentCard

Trust infrastructure for agentic payments on Monad. **Agents never hold the user's keys — they
hold scoped, revocable, policy-bound delegated keys, presented as a "card."**

The user's root of trust is a passkey. Issuing a card generates a fresh agent keypair, registers
the agent under ERC-8004, and writes a spending policy on-chain under the user's authority. Every
spend is verified against the whole chain, and **every attempt — approved or refused — becomes
public on-chain data.**

> **Status: Phase 1, contracts complete.** 58 tests green, including 6 that run against the real
> ERC-8004 registries on Monad Testnet. Not yet deployed; app layer not yet built. See
> [Status](#status).

---

## Trust chain

```
   ┌─────────────┐
   │   Passkey   │  hardware-held, no seed phrase
   └──────┬──────┘
          │ WebAuthn PRF → 32 bytes → BIP-39 → BIP-32  m/44'/60'/0'/0/0
          │ (off-chain, in page memory, for the life of one signing session)
          ▼
   ┌─────────────┐
   │  Owner EOA  │  plain secp256k1. On-chain this is an ORDINARY EOA.
   └──────┬──────┘
          │ owner-signed tx: issueCard(agentKey, cap, merchantRoot, validUntil)
          ▼
   ┌──────────────────────────────────────────┐
   │  Card (on-chain policy)                  │──► ERC-8004 Identity Registry
   │  cardId = keccak256(owner, agentKey)     │    (agent gets an ERC-721 identity)
   │  dailyCap · merchantRoot · validUntil    │
   │  policyVersion · revoked                 │
   └──────┬───────────────────────────────────┘
          │ authorizes exactly one key
          ▼
   ┌─────────────┐
   │  Agent key  │  fresh, random, NOT passkey-derived. Disposable by design.
   └──────┬──────┘
          │ EIP-712 SpendAuth signature (the ONLY thing an agent ever signs)
          ▼
   ┌─────────────┐        ┌──────────────┐        ┌─────────────────────┐
   │ SpendRouter │───────►│  SpendGate   │───────►│ owner ─$─► merchant │
   │ try/catch   │        │ 10 checks    │        └─────────────────────┘
   └──────┬──────┘        └──────┬───────┘
          │ SpendDeclined        │ SpendApproved
          ▼                      ▼
   ┌────────────────────────────────────────┐
   │ ERC-8004 Reputation Registry           │  ← written by the MERCHANT
   │ approved / declined, publicly queryable│
   └────────────────────────────────────────┘
```

The asymmetry is **lifecycle, not curve**: both keys are secp256k1, but the owner key is
passkey-rooted and recoverable while agent keys are unrooted and disposable.

---

## Research findings

Everything below was verified against primary sources or live chain state, not assumed.

### Mera security model (honest summary)

Mera does **not** do on-chain P256/WebAuthn verification, and there is no smart account.

- It derives a **regular secp256k1 EOA** from the passkey: WebAuthn **PRF extension** → 32 secret
  bytes → BIP-39 mnemonic → BIP-32 at `m/44'/60'/0'/0/0`. Exported mnemonics work in MetaMask or
  Rabby.
- The passkey is the **deterministic derivation root and recovery mechanism, not an on-chain
  signer.** On-chain, every owner action is an ordinary EOA check. Nothing is "smart-account gated."
- The owner private key **exists in page memory** for the life of a signing session. We use
  **prompt-per-transaction** for all owner actions (issue, updatePolicy, revoke), ending the
  session in a `finally` block. These actions are rare and high-stakes, so a biometric prompt each
  time is a security feature. No long-lived owner session is ever held.
- **rpId domain binding:** passkeys are bound to the origin that created them. If the app changes
  domains, **accounts are unrecoverable** except through the 24-word mnemonic. This is a real,
  permanent caveat, not a deployment detail.
- Requirements: HTTPS or localhost, and a PRF-capable authenticator (iCloud Keychain, 1Password,
  Google Password Manager). **Desktop Chrome local-profile passkeys throw `PRF_UNAVAILABLE`** and
  must be handled explicitly. Other errors: `PASSKEY_OPERATION_FAILED`, `CRYPTO_UNAVAILABLE`,
  `SESSION_ENDED`.
- **Gas:** Mera accounts are plain EOAs, so there is no paymaster and no bundler. Monad charges the
  **declared `gasLimit`, not gas used**, so explicit, sane gas values matter more than usual.

Because Mera supplies both the account and the auth, **Privy and Pimlico are not used**: Privy
duplicates the authentication, and Pimlico's 4337 bundler/paymaster has nothing to bundle for an EOA.

### Mera, as actually implemented (two corrections to the guide)

Verified against `@category-labs/mera@0.2.0` and a real transaction, not just the docs.

**1. Mera does not derive keys.** The guide describes PRF → BIP-39 → BIP-32, but the library's
`createSecp256k1SigningSession({ privateKey })` takes a **private key that is already derived**. The
whole derivation step is the application's job, and it lives in [`lib/mera.ts`](lib/mera.ts):

```
WebAuthn PRF output (32 bytes)
  → entropyToMnemonic            @scure/bip39      (24 words, never shown)
  → mnemonicToSeedSync
  → HDKey.derive("m/44'/60'/0'/0/0")  @scure/bip32
  → private key
  → createSecp256k1SigningSession → toViemAccount   (viem LocalAccount, source: "mera")
```

Mera supplies the passkey ceremony, the signing session, and the viem adapter. Everything between
PRF output and private key is ours.

**2. `@scure/bip39` v2 requires the `.js` suffix** on wordlist subpaths
(`@scure/bip39/wordlists/english.js`). The extensionless form most guides show throws
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

**What is proven, and how.** `npm run mera:check:onchain` runs the full chain headlessly and
[confirmed a real transaction on Monad Testnet](https://testnet.monadvision.com/tx/0xde1231598cd5c0e99f2ef8c5c857746510a143e1a4d0a709ab8abc465c972c83)
sent by a PRF-derived account, in block 65700942:

| Link | Result |
|---|---|
| 32-byte PRF → 24-word mnemonic → key | ok |
| Address from `toViemAccount` == `getEvmAddress(session.publicKey)` | ok |
| Same PRF reproduces the same address | ok — this is the whole recovery story |
| EIP-191 and EIP-712 signing | ok — EIP-712 is what the agent flow needs |
| Transaction accepted by Monad, `from` == derived address | ok |
| Signing after `session.end()` | rejected with `SESSION_ENDED` |

**What is still unproven:** the WebAuthn ceremony itself, which needs a real authenticator and
cannot be tested headlessly. [`app/mera/page.tsx`](app/mera/page.tsx) reports each step separately so
a failure at step 1 is identifiable as a provider problem rather than a bug in AgentCard.

**A live warning about entropy.** The check derives from a fixed stand-in PRF value of 32 `0x07`
bytes. That address — `0x29458C602E3DB4fC3b54EC2bbEE26Dbe64C7779f` — already held **4.8 MON across
9 transactions** that we never sent: other people derived the same key from the same obvious test
entropy. The PRF output *is* the wallet. A predictable one is a public wallet.

### Monad Testnet

| Parameter | Value |
|---|---|
| Chain ID | `10143` (verified via `cast chain-id`) |
| Public RPC | `https://testnet-rpc.monad.xyz` |
| Native token | MON |

### ERC-8004 registries — a correction that matters

Monad's ERC-8004 guide publishes these addresses:

| Registry | Address in the guide | Code on chain 10143 |
|---|---|---|
| Identity | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | **none** |
| Reputation | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | **none** |

Those are the **mainnet** singletons (they appear as `MAINNET_ADDRESSES` in the ERC-8004 contracts
repo). Verified empty across three independent RPCs. The **testnet** deployments we integrate
against are:

| Registry | Monad Testnet (10143) | Verified |
|---|---|---|
| Identity | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `AgentIdentity`/`AGENT`, `getVersion()` = `2.0.0` |
| Reputation | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `2.0.0`; `getIdentityRegistry()` → Identity ✓ |
| Validation | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | deployed (unused in Phase 1) |

`test_guideAddressesAreNotDeployedOnTestnet` pins this finding so no future doc-following change can
silently reintroduce the mainnet addresses.

### Whose registries are these?

**Third-party reference deployments by the ERC-8004 project — not ours, and not anonymous
community forks.** Provenance, verified on-chain:

| Evidence | Value |
|---|---|
| Proxy owner (both registries) | `0x547289319C3e6aedB179C0b8e8aF0B5ACd062603` |
| Matches the project's published owner | Yes — `VANITY_DEPLOYMENT_GUIDE.md` in `erc-8004/erc-8004-contracts` |
| Deployed via | SAFE Singleton Factory `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7` (same address on every chain) |
| Implementation (Identity) | `0x7274e874ca62410a93bd8bf61c69d8045e399c02` |
| Implementation (Reputation) | `0x16e0fa7f7c56b9a767e34b192b51f921be31da34` |
| Cross-chain determinism | The same `0x8004A818…` vanity address holds registry code on Base Sepolia |

The `0x8004…` vanity prefix is not decorative: CREATE2 through a chain-independent factory is what
makes the registry live at the *same address on every chain*, which is what lets an agent's identity
be resolved cross-chain without a per-chain address book.

**Caveat we accept knowingly:** these proxies are **UUPS-upgradeable and owned by that single EOA**,
so the registry's behaviour can change under us without our consent. We integrate anyway, because
the alternative — deploying our own lookalike registries — trades a real, shared, canonical namespace
for a private one that no third party would ever query, which would defeat the entire point of
using ERC-8004. The upgrade key is a trust assumption of the standard's current rollout, not of
AgentCard specifically, and it is one every ERC-8004 integrator on this chain shares.

---

## Who writes the reputation, and why it is not us

This is the single most important design constraint we found, and it **overturned the original
plan**. The canonical Reputation Registry contains:

```solidity
// SECURITY: Prevent self-feedback from owner and operators
require(!IIdentityRegistry(_identityRegistry).isAuthorizedOrOwner(msg.sender, agentId),
        "Self-feedback not allowed");
```

`register()` mints the agent's identity NFT to `msg.sender`. So **whoever registers an agent is
permanently barred from rating it.** The original design — our own contracts publishing attestations
about our own agents — is not merely blocked, it is incoherent: issuer-authored reputation carries
no information.

**Resolution: the merchant is the feedback author.** `giveFeedback` is otherwise permissionless, so
the counterparty attests to each outcome, approvals and refusals alike. This is exactly ERC-8004's
client-feedback model, so we comply with the spec rather than building a lookalike. It also fits the
gas story: the merchant already submits and pays for the transaction.

CardManager custodies the identity NFT, which means it is *structurally incapable* of rating its own
agents — enforced by the registry, not by our good intentions. `test_issuerCannotRateItsOwnAgent`
and `test_merchantCanRateAgent_butIssuerCannot` assert both halves, the latter against the real
deployed registry.

---

## How declines get on-chain

Judges ask this first, so: **a revert unwinds state *and* erases events.** A refused spend that
simply reverts leaves no trace, and a reputation trail of only successes is worth very little.

`SpendRouter` calls `SpendGate.spend` inside `try/catch`. The inner revert still unwinds everything
— no funds move, no nonce is consumed — while the router's own frame survives to emit
`SpendDeclined(cardId, merchant, amount, nonce, reasonSelector)`. The refusal becomes permanent
public data, paid for by the submitter's gas.

The custom-error taxonomy **is** the audit trail: each decline surfaces a distinct 4-byte selector,
so "declined" is never a shrug — it says `DailyCapExceeded`, `MerchantNotAllowed`, or `CardRevoked`.

Verified by `test_decline_isEmittedOnChainWithReason`, `test_declineReasons_areDistinguishableOnChain`,
and `test_decline_leavesNoStateBehind`.

---

## Why refusal reasons live in the attestation

Public Monad RPCs cap `eth_getLogs` at a **100-block range** (verified on
`testnet-rpc.monad.xyz` and `rpc.ankr.com/monad_testnet`; `drpc.org` was unreachable). Reading
an agent's history since deployment would therefore need thousands of paginated requests, or a
paid archive node — so a verifier built on events cannot actually read history.

So the reason is written **into the ERC-8004 attestation** rather than left only in the
`SpendDeclined` event: `tag1` carries the reason (`DailyCapExceeded`), `tag2` the verdict
(`declined`). Both are stored by the registry, so the whole trail — refusals and their causes —
is readable with one `eth_call` and no infrastructure. `SpendRouter` still emits
`SpendDeclined`, which remains the cheaper real-time signal for anything already watching.

Only `tag1`/`tag2` are stored; `endpoint` and `feedbackURI` are emitted but not kept, so they
could not carry this. The mapping lives in
[`DeclineReasons.sol`](contracts/src/lib/DeclineReasons.sol).

## Verification order

`SpendGate.spend` checks, in order, each with a distinct custom error:

| # | Check | Error |
|---|---|---|
| 1 | Card exists | `CardNotFound` |
| 2 | Not revoked | `CardRevoked` |
| 3 | Not expired | `CardExpired` |
| 4 | Auth still fresh | `DeadlineExpired` |
| 5 | Token is the pinned payment token | `TokenNotAllowed` |
| 6 | Policy generation matches | `PolicyVersionStale` |
| 7 | Recovered signer == `card.agentKey` | `BadAgentSignature` |
| 8 | Nonce unused | `NonceUsed` |
| 9 | Merkle proof against `merchantRoot` (skipped if root is 0) | `MerchantNotAllowed` |
| 10 | Daily cap | `DailyCapExceeded` |

**Ordering is a reporting and gas decision, not a security one.** Every failure reverts, so all
state is unwound regardless of order — nothing is "burned" by a late check. We therefore run cheap
checks before `ecrecover`: the original spec placed the deadline check *after* signature recovery,
which only wastes ~3k gas on an auth already known to be stale.

`merchantRoot == bytes32(0)` means **any merchant** — an explicit, documented wildcard. Merchant
scoping is *scoping*, not confidentiality: with one merchant the root equals the leaf and is
trivially enumerable. We do not claim otherwise.

Daily caps use **UTC calendar-day buckets**. The accepted edge: a card can spend a full cap at 23:59
and another at 00:01. A true trailing window needs per-spend history; the cap is a blast-radius
limit, not an accounting ledger. `test_dayRollover_twoFullCapsAcrossMidnightIsExpected` asserts this
is by design rather than leaving it to be discovered.

---

## Deliberate deviations from the original spec

Both are documented in code at the point of deviation.

**1. `policyVersion` is part of the signed `SpendAuth`.** The spec listed
`{cardId, merchant, token, amountUSD, nonce, deadline}` but also required that bumping
`policyVersion` kill stale authorizations. Those are incompatible: if the signed payload does not
commit to the policy version, an auth signed under the old policy stays valid forever and
`policyVersion` is inert. Adding the field is the only way to satisfy the stated intent.

```
SpendAuth(bytes32 cardId,address merchant,address token,uint256 amount,
          uint256 nonce,uint256 deadline,uint64 policyVersion)
```
EIP-712 domain: `{ name: "AgentCard", version: "1", chainId, verifyingContract }`.

**2. `amountUSD` → `amount`, with a single pinned payment token.** A USD-denominated cap cannot
bound an *arbitrary* token without a price oracle. Rather than imply an oracle we do not have,
`SpendGate` pins one payment token (MockUSD, 6 decimals) and rejects anything else with
`TokenNotAllowed`. `token` stays in the signed struct so the signature commits to it.

---

## Considered and rejected

**Off-chain signed certificates** (passkey signs a policy cert; agent presents cert + spend sig).
Better privacy — policies stay off-chain — and no issuance gas. Rejected because **revocation
becomes a distributed-systems problem**: killing a certificate needs a revocation list, an expiry
window, or an on-chain nullifier, and until it propagates the agent is still spendable. On-chain
policy makes revocation atomic and legible: one transaction, effective at the next block, publicly
auditable. For a trust product, legible beats private.

**Monotonic nonces.** The spec asked for strictly-increasing counters, but the error was named
`NonceUsed` — two different schemes. Under a relayer, auths can land out of order, and a monotonic
counter permanently kills a lower nonce that merely arrived late, through no fault of the agent. We
use an order-independent used-set. `test_nonces_outOfOrderStillSettle` is the case that decided it.

**Nonce bitmaps.** Rejected as premature: they optimize storage for high-frequency signers, and at
demo scale the added packing logic is more to audit for no benefit.

**Un-revoke.** Deliberately absent. A new card is a new issuance. Agent keys are also permanently
consumed, so a revoked agent cannot be resurrected by re-issuing to the same key
(`test_issueCard_agentKeyCannotBeReused_evenAfterRevocation`).

**Long-lived owner sessions.** Rejected: they keep the passkey-derived key in page memory across
unrelated activity. Owner actions are rare, so prompt-per-transaction costs little.

**Privy + Pimlico.** Dropped once Mera was chosen — see above.

**Multi-token caps via a price oracle.** Deferred, not overlooked. A cap denominated in USD across
arbitrary tokens requires a price feed, and a price feed is a new trust assumption, a new failure
mode (stale or manipulated prices become a spending-limit bypass), and a new dependency to explain.
Pinning one settlement token removes that assumption from the demo entirely. The natural Phase 2
shape is a per-token cap table, or an oracle-priced cap with an explicit staleness bound — either
way it is an additive change: `SpendGate` already commits `token` to the signed payload, so the
enforcement point does not need re-architecting.

---

## Trust boundaries and caveats

**The ERC-20 approval sits upstream of the policy engine.** The owner approves `SpendGate`, so
SpendGate can move the owner's tokens. It can only ever do so through a complete, valid
verification, and revocation severs every path to it permanently
(`test_revocation_isInstantAndTotal`). But be precise about what this means: **an unbounded approval
would mean a bug in SpendGate drains the owner regardless of any card policy**, because the approval
is granted before any policy is consulted. Approve a bounded amount. The tests do.

**Agent key handling is demo-only.** In this build the agent's private key is generated client-side
and handed to the demo agent runtime (env/localStorage). That is *not* a production key-custody
story — it is deliberately the weakest link, and it is survivable only because the key is scoped,
capped, merchant-restricted, expiring, and instantly revocable. The design assumption is not that
agent keys stay secret; it is that **a stolen agent key is a bounded loss**.

**The registry has no reverse index.** ERC-8004 maps `agentId → wallet`, never the reverse, so
CardManager maintains `agentKey → cardId` itself. The Verifier flow depends on it.

**`bindAgentWallet` is a separate call by necessity.** `setAgentWallet` needs an EIP-712 signature
from the agent key over a digest containing `agentId` — which does not exist until `register()` has
run. It cannot be folded into `issueCard`. Since the agent's own signature is the authorization,
submission is permissionless: the agent signs, any relayer submits, and the owner is not prompted
again.

---

## Deployed addresses

<!-- DEPLOYED:START -->
Monad Testnet (chain `10143`), deployed +058721-01-09T01:10:33.000Z from commit `bca377af1776c9543b97fc3010c06e77cf6df239`.

| Contract | Address | Deployer |
|---|---|---|
| `CardManager` | [`0xBE65B96d591840AaCBe591B327abe92Cddc64D24`](https://testnet.monadvision.com/address/0xBE65B96d591840AaCBe591B327abe92Cddc64D24) | this deployment |
| `SpendGate` | [`0xE020378b873d10dB86f3a1FF5c781db58B034794`](https://testnet.monadvision.com/address/0xE020378b873d10dB86f3a1FF5c781db58B034794) | this deployment |
| `SpendRouter` | [`0xFc5Eb559b062F48D8f5C7d04F01C07568eB43124`](https://testnet.monadvision.com/address/0xFc5Eb559b062F48D8f5C7d04F01C07568eB43124) | this deployment |
| `MockMerchantA` | [`0xdaf1f3fdc83e49BD4D50fDA1613c15D1C7552244`](https://testnet.monadvision.com/address/0xdaf1f3fdc83e49BD4D50fDA1613c15D1C7552244) | this deployment |
| `MockMerchantB` | [`0x51fA5af542179cDe11e517b377f7fc2e443D86e8`](https://testnet.monadvision.com/address/0x51fA5af542179cDe11e517b377f7fc2e443D86e8) | this deployment |
| `MockMerchantC` | [`0x0B0DFdc99265ACead416F9872B283EDD0D33b87A`](https://testnet.monadvision.com/address/0x0B0DFdc99265ACead416F9872B283EDD0D33b87A) | this deployment |
| `ReputationReader` | [`0xc86630cB8901ff7038e2Fa3b48C3b2E4d28e159e`](https://testnet.monadvision.com/address/0xc86630cB8901ff7038e2Fa3b48C3b2E4d28e159e) | this deployment |
| `AUSD` (settlement token) | [`0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC`](https://testnet.monadvision.com/address/0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC) | Agora |
| `IdentityRegistry` | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.monadvision.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) | ERC-8004 project |
| `ReputationRegistry` | [`0x8004B663056A597Dffe9eCcC1965A193B7388713`](https://testnet.monadvision.com/address/0x8004B663056A597Dffe9eCcC1965A193B7388713) | ERC-8004 project |

Regenerate with `npm run write-config` after any redeploy.
<!-- DEPLOYED:END -->

## Live demo run

The 90-second demo, executed on Monad Testnet by `npm run demo` against the deployment above.
Every row is a real transaction; all 7 contracts are Sourcify-verified (`exact_match`).

| Step | Outcome | Transaction |
|---|---|---|
| Owner issues card: $50/day, merchants {A} | agent registered as ERC-8004 identity **#1935** | [`0x…`](https://testnet.monadvision.com/tx/0x28d21122dfa05248518251db1a0cb0b62ff445ea38dc418f8caf18497ef1f623) |
| Agent buys $20 at merchant A | **approved** | [`0x28d2…623`](https://testnet.monadvision.com/tx/0x28d21122dfa05248518251db1a0cb0b62ff445ea38dc418f8caf18497ef1f623) |
| Agent tries $200 | **declined** `DailyCapExceeded` | [`0xa65b…f4b`](https://testnet.monadvision.com/tx/0xa65bf8ef173a68159f2e43e77fc964bd9560bc77f7a2ea0b7c0f6203e0eaef4b) |
| Agent tries merchant B | **declined** `MerchantNotAllowed` | [`0x5a2d…a68`](https://testnet.monadvision.com/tx/0x5a2d8237d12a67f9b971d0db22b8d78ff41644c5e4b58a7a88ff8d1d8b55ba68) |
| Owner revokes, agent retries | **declined** `CardRevoked` | [`0xec4e…271`](https://testnet.monadvision.com/tx/0xec4e3d77a176bda0a26f61e9f6778c4daec6b63614546cca99ca4e216ad88271) |

Agent `0x448c24e7e9aB4400FeA8f5D829db49f9f91732c5` — verify it yourself at `/verify`. Read back
from the canonical registry with nothing but `eth_call`:

```
verdict      REVOKED | approved 1 | declined 3 | agentId 1935
identity     held by CardManager
attestations approved  approved            by 0x10AC2e0abE…  (merchant A)
             declined  DailyCapExceeded    by 0x10AC2e0abE…
             declined  CardRevoked         by 0x10AC2e0abE…
             declined  MerchantNotAllowed  by 0xBf7B5E8004…  (merchant B)
cross-check  consistent
```

The agent ended with 0 MON and 0 mUSD: it signed four authorizations and never sent a transaction.

## Contracts

| Contract | Role |
|---|---|
| `CardManager.sol` | Issuance, policy, revocation; ERC-8004 registration; custodies agent identity NFTs |
| `SpendGate.sol` | The enforcement point: full-chain verification and settlement |
| `SpendRouter.sol` | `try/catch` wrapper that puts **refusals** on-chain |
| `ReputationReader.sol` | Third-party trust query: agent address → `{approved, declined, revoked, activeSince}` |
| `mocks/MockUSD.sol` | 6-decimal ERC-20 with `faucet()` |
| `mocks/MockMerchant.sol` | The demo shop, and the **author** of the reputation trail |

`ReputationReader` composes the registry's own `getClients` + `getSummary` rather than
reimplementing counting, so the canonical registry stays the source of truth. Approved/declined
counts come from tag filtering (`"payment"` / `"approved"` \| `"declined"`).

---

## Tests

```bash
cd contracts
forge test            # 58 tests, including 6 forked against live Monad Testnet
forge test --no-match-path 'test/MonadForkIntegration.t.sol'   # offline only
```

`foundry.toml` sets `network = "monad"`; without it Foundry 1.8 instantiates an "ethereum" EVM and
refuses to fork chain 10143.

| Suite | Covers |
|---|---|
| `SpendGate.t.sol` (23) | Full-chain approval, every decline reason, replay, deadline, Merkle proofs, cap boundary and rollover, revocation |
| `CardManager.t.sol` (15) | Issuance, access control, terminal revocation, policy versioning, `bindAgentWallet` |
| `ReputationTrail.t.sol` (12) | Declines on-chain, no state left behind, merchant attestation, reader reports |
| `DemoScript.t.sol` (3) | The 90-second demo as an executable test, plus fuzzed cap and signature invariants |
| `MonadForkIntegration.t.sol` (6) | The whole flow against the **real** registries on chain 10143 |
| `CrossLanguageConstants.t.sol` (3) | Pins the EIP-712 typehash, Merkle leaf encoding and decline selectors shared with TypeScript |
| `DeployedSmoke.t.sol` (2) | Post-deploy: the demo against the **deployed** addresses (skips until they exist) |

Unit tests run against faithful local replicas of the registries (reproducing the self-feedback
guard, `getSummary` tag filtering, and `setAgentWallet` signature checks verbatim). The fork suite
exists to prove those replicas are not flattering us.

### A bug the tests caught

`register()` uses `_safeMint`, which calls `onERC721Received` on contract recipients. CardManager is
a contract, so **every `issueCard` reverted with `ERC721InvalidReceiver`** until it implemented the
hook. This would have failed identically on Monad — it was caught before deployment only because the
mocks replicate the real registry rather than approximating it.

---

## Status

**Done:** contracts, 64 passing tests (including the post-deploy smoke test), verified ERC-8004 integration against live testnet
registries, and the full deploy toolchain — deploy script with registry pre-flight checks, address
generator, funder/top-up, live demo runner, and a post-deploy smoke test.

**Deployed:** live on Monad Testnet, all 7 contracts Sourcify-verified, post-deploy smoke test
green against the deployed addresses, and the full demo executed live (see
[Live demo run](#live-demo-run)).

**Mera de-risked, ceremony included:** derivation, signing and a real Monad transaction confirmed
from a PRF-derived account, and `npm run test:passkey` now drives the real `/mera` page through an
actual WebAuthn ceremony in headless Chrome using a virtual authenticator with PRF enabled. The same
passkey reproduces the same address and sends a confirmed transaction. The only thing left that
automation cannot settle is whether a *particular real provider* supports PRF — see
[TESTING.md](TESTING.md) layer 9.

**A product, not a test harness.** Seven screens inside one shell — a left rail on desktop, a
bottom bar on phones — all built from one design system (tokens in `app/globals.css`, primitives
in `components/ui`), with no ad-hoc inline styling left in any screen.

| Route | What it is |
|---|---|
| `/` | Dashboard: active cards, today's approvals and refusals, recent activity |
| `/cards` | Every card as an actual card; issue one with a limit and a merchant list |
| `/cards/[id]` | The card, its policy, and **Atlas working through its goals** beside it |
| `/activity` | The on-chain record across all cards, filterable by result and merchant |
| `/agents` | ERC-8004 identities and their standing |
| `/verify` | Public, sign-in free — the record anyone can query |
| `/settings` | Account and passkey, framed as settings rather than a diagnostic |

Every owner action runs its own passkey ceremony through one helper and ends the session in a
`finally` block, so the derived key never outlives the action it authorized.

**It settles in real money.** Cards are denominated in **AUSD**, Agora's dollar stablecoin, live
on Monad Testnet at `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` — not a token we minted. Six
decimals, which is exactly why SpendGate pins a single token. The owner claims from Agora's
public faucet; that faucet's ABI is unpublished, so `requestFunds(address)` was recovered from its
proxy implementation's bytecode and confirmed with a live claim.

**The merchants are real counterparties.** Lagos Cloud Hosting, Horizon Data API and Riverside
Subscriptions — names stored on-chain in each merchant contract, and the sort of thing an agent
actually buys. Two sit inside a typical card's policy and one deliberately outside it, so an
out-of-scope refusal happens with a named merchant rather than "Merchant B".

**The agent decides.** Atlas, a procurement assistant, holds three goals and picks its own amount
and merchant for each. It reacts to *why* it was refused: over the cap it records the shortfall and
defers that goal, out of scope it marks the goal blocked and does not retry, revoked it stops
entirely. The transcript narrates that reasoning, so the behaviour is legible rather than implied.
Deterministic and LLM-free, so it is safe to run live.

`npm run test:ui` drives all of it in headless Chrome against the live deployment, including a
mobile pass at 390×844.

The demo script is already pinned by `test_theNinetySecondDemo`, so the UI has a contract-level
specification to build against rather than the reverse.

## Repository layout

| Path | Contents |
|---|---|
| `contracts/` | Foundry project: sources, tests, deploy script |
| `config/chain.ts` | Monad Testnet params and canonical ERC-8004 addresses |
| `config/addresses.ts` | Generated at deploy time — never hand-edited |
| `scripts/fund.ts` | Balance table and threshold top-up for owner + relayer |
| `scripts/write-config.ts` | Broadcast artifact → `addresses.ts` + README table |
| `scripts/demo.ts` | Live end-to-end run against the deployed contracts |
| `DEPLOY.md` | Step-by-step deploy runbook |
| `app/` | Next.js 16 App Router: home, `/verify`, `/demo`, and the `/mera` passkey check |
| `app/api/` | Demo-only routes: owner issue/revoke, onboarding top-up, gas-paying relayer |
| `lib/merkle.ts` | Merchant scoping, matching the Solidity leaf encoding |
| `lib/server.ts` | Server-side demo wallets, and why they are demo-only |
| `lib/contracts.ts` | ABIs, deployed addresses, decline-reason decoding |
| `lib/mera.ts` | Passkey → EOA derivation and prompt-per-transaction sessions |
| `scripts/mera-check.ts` | Headless proof of the chain, with `--onchain` |
| `scripts/test-passkey.ts` | End-to-end passkey test via Chrome's virtual authenticator |
| `scripts/test-ui.ts` | Drives console → demo → verify in a real browser |
| `TESTING.md` | What is tested, how, and the one manual step |

---

## Testing

See [TESTING.md](TESTING.md). Short version:

```bash
cd contracts && forge test              # 62 passing, 6 of them against live registries
cd .. && npm run mera:check:onchain     # passkey derivation + a real transaction
npm run build && npm run test:passkey   # the WebAuthn ceremony, headless
npm run demo                            # the whole demo, live on testnet
```

## Running the app

```bash
npm install
npm run dev            # /verify works with no device; /mera needs a passkey
npm run mera:check      # headless: derivation + signing, no device needed
npm run mera:check:onchain   # also sends a real transaction (needs FUNDER_PRIVATE_KEY)
```

WebAuthn requires a secure context, so use `localhost` or HTTPS. **Passkeys are bound to the domain
that created them**, so a passkey made on `localhost` will not work on a deployed domain — create the
demo passkey on whatever domain you will actually present from.

If `next dev` fails with `OS file watch limit reached`, raise the inotify limit:

```bash
sudo sysctl fs.inotify.max_user_watches=524288
```

`next build && next start` needs no watches and is unaffected.
