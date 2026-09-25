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
Monad Testnet (chain `10143`), deployed +058693-12-08T00:02:03.000Z from commit `f23ef7ebc22c683d53f5df47cda23ff534908de1`.

| Contract | Address | Deployer |
|---|---|---|
| `MockUSD` | [`0x4BEE0Ecd3FB0f65A8a6982E2b3abB8baA14d731F`](https://testnet.monadvision.com/address/0x4BEE0Ecd3FB0f65A8a6982E2b3abB8baA14d731F) | this deployment |
| `CardManager` | [`0xbfe4A4F6de7eC6e5153C3742541Ab9C9811f9FE5`](https://testnet.monadvision.com/address/0xbfe4A4F6de7eC6e5153C3742541Ab9C9811f9FE5) | this deployment |
| `SpendGate` | [`0x540d97563C111b91f087C846ba19578f6BBff157`](https://testnet.monadvision.com/address/0x540d97563C111b91f087C846ba19578f6BBff157) | this deployment |
| `SpendRouter` | [`0xBA379a9f4cd0D774e3a4E4388E2FefD86ACC2714`](https://testnet.monadvision.com/address/0xBA379a9f4cd0D774e3a4E4388E2FefD86ACC2714) | this deployment |
| `MockMerchantA` | [`0xEb198C0092Ade3d3Cd22e33A950A1A39eaDfEF15`](https://testnet.monadvision.com/address/0xEb198C0092Ade3d3Cd22e33A950A1A39eaDfEF15) | this deployment |
| `MockMerchantB` | [`0xbb6B254F08D1340c2F72F7E1725e2A243c38b645`](https://testnet.monadvision.com/address/0xbb6B254F08D1340c2F72F7E1725e2A243c38b645) | this deployment |
| `ReputationReader` | [`0x1dBFfDDDDEa7fAE6dF89BF5291a07405B62ba571`](https://testnet.monadvision.com/address/0x1dBFfDDDDEa7fAE6dF89BF5291a07405B62ba571) | this deployment |
| `IdentityRegistry` | [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://testnet.monadvision.com/address/0x8004A818BFB912233c491871b3d84c89A494BD9e) | ERC-8004 project |
| `ReputationRegistry` | [`0x8004B663056A597Dffe9eCcC1965A193B7388713`](https://testnet.monadvision.com/address/0x8004B663056A597Dffe9eCcC1965A193B7388713) | ERC-8004 project |

Regenerate with `npm run write-config` after any redeploy.
<!-- DEPLOYED:END -->

## Live demo run

The 90-second demo, executed on Monad Testnet by `npm run demo` on 2026-09-22 against the
deployment above. Every row is a real transaction; all contracts are Sourcify-verified
(`exact_match`).

| Step | Outcome | Transaction |
|---|---|---|
| Owner issues card: $50/day, merchants {A} | agent registered as ERC-8004 identity **#1915** | [`0x376d…a7d`](https://testnet.monadvision.com/tx/0x376d2e4d42c0cb49af3d3d52d3a74db14fb012ba19ed6cb33b7789aeaa9aae7d) |
| Agent buys $20 at merchant A | **approved** | [`0x62a8…62c`](https://testnet.monadvision.com/tx/0x62a87e4eee052d7259d3afed295b38a4303e99ecb2447351c2879249012b262c) |
| Agent tries $200 | **declined** `DailyCapExceeded` | [`0x60d8…4a5`](https://testnet.monadvision.com/tx/0x60d8a0aa36578a8ae375fe3de944201105c3d35aa3336cad4d536f767e4dc4a5) |
| Agent tries merchant B | **declined** `MerchantNotAllowed` | [`0xb593…cd`](https://testnet.monadvision.com/tx/0xb5930a79cad0cb81f9c1ed62f5aab3e2b927040575bd7f556d536609892727cd) |
| Owner revokes | card revoked | [`0x958e…28e`](https://testnet.monadvision.com/tx/0x958e80207be2a4a58852ba507e863143f503b9c9917bdd6d1913a588f712b28e) |
| Agent tries again | **declined** `CardRevoked` | [`0x09ac…200`](https://testnet.monadvision.com/tx/0x09ac50dae7637317dbac437213309cf97bb7e9442320f65d41a3665e790a5200) |

Independently confirmed with `cast`, not just the script's own output:

- Identity #1915 on the canonical Identity Registry is owned by CardManager.
- The canonical Reputation Registry lists **both merchants** as the clients who rated agent #1915,
  so the trail was authored by counterparties, not by us.
- The `DailyCapExceeded` transaction contains a `SpendDeclined` log from SpendRouter carrying
  selector `0xcc70389d`: the refusal is on-chain even though the spend itself reverted.
- The agent (`0x9e2C418F…4313`) ended with 0 MON and 0 mUSD: it signed four authorizations
  and never sent a transaction.

Final verifier view: **1 approved, 3 declined, revoked.**

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
| `ReputationTrail.t.sol` (11) | Declines on-chain, no state left behind, merchant attestation, reader reports |
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

**Done:** contracts, 63 passing tests (including the post-deploy smoke test), verified ERC-8004 integration against live testnet
registries, and the full deploy toolchain — deploy script with registry pre-flight checks, address
generator, funder/top-up, live demo runner, and a post-deploy smoke test.

**Deployed:** live on Monad Testnet, all 7 contracts Sourcify-verified, post-deploy smoke test
green against the deployed addresses, and the full demo executed live (see
[Live demo run](#live-demo-run)).

**Mera de-risked:** derivation, signing and a real Monad transaction all confirmed from a
PRF-derived account. Only the passkey ceremony itself remains, and it needs a physical device —
run `npm run dev` and open `/mera` on a phone.

**Not yet built:** owner console (card issuance UI on top of `lib/mera.ts`), agent demo panel,
Verifier page.

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
| `app/` | Next.js 16 App Router: home plus the `/mera` passkey check |
| `lib/mera.ts` | Passkey → EOA derivation and prompt-per-transaction sessions |
| `scripts/mera-check.ts` | Headless proof of the chain, with `--onchain` |

---

## Running the app

```bash
npm install
npm run dev            # then open http://localhost:3000/mera
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
