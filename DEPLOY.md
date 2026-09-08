# Deploy runbook — Monad Testnet

Every step is a command. Nothing is copied by hand, and nothing is verified by memory.

**Prerequisites**

- A deployer key with **≥ 2 MON** on Monad Testnet. Simulation estimates **~1.17 MON**; the buffer
  covers Monad charging the *declared* `gasLimit` rather than gas used.
- `export MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz`
- `export DEPLOYER_PRIVATE_KEY=0x...`

---

### 1. Pre-flight: confirm the registries before spending gas

```bash
cd contracts && forge test          # 58 green, incl. 6 forked against the live registries
forge script script/Deploy.s.sol --rpc-url $MONAD_TESTNET_RPC
```

The script `require`s that both registries have code and are wired to each other, so a simulation
that completes has already ruled out the mainnet-address trap in Monad's own guide.

### 2. Deploy and verify in one shot

```bash
cd contracts
forge script script/Deploy.s.sol \
  --rpc-url $MONAD_TESTNET_RPC \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast \
  --verify --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/
```

Sourcify needs no API key. If verification is flaky mid-hackathon, deploy first and verify after:

```bash
forge verify-contract <address> <ContractName> \
  --chain 10143 --verifier sourcify \
  --verifier-url https://sourcify-api-monad.blockvision.org/
```

Judges do click through to the explorer, so treat verification as part of deploying, not as optional.

### 3. Write addresses into config and README

```bash
cd .. && npm run write-config
```

Generates `config/addresses.ts` (checksummed, stamped with the exact commit hash) and fills the
README's deployed-addresses table from the broadcast artifact.

### 4. Post-deploy smoke test: the demo against the real deployment

```bash
cd contracts
CARD_MANAGER=$(...)  SPEND_GATE=$(...)  SPEND_ROUTER=$(...)  MOCK_USD=$(...) \
MERCHANT_A=$(...)    MERCHANT_B=$(...)  REPUTATION_READER=$(...) \
forge test --match-path test/DeployedSmoke.t.sol -vv
```

Values come straight from `config/addresses.ts`. This is the step that catches a deployment that
*succeeded* but wired something wrong — a gate pointing at the wrong CardManager, merchants
disagreeing with the reader about which registry is canonical. `DemoScript.t.sol` proves the code is
right; this proves the **deployment** is right.

### 5. Commit the deployment

```bash
git add config/addresses.ts README.md contracts/broadcast
git commit -m "Deploy to Monad Testnet"
```

`config/addresses.ts` records the commit the contracts were **built from**, so "which code is at
this address" is never guesswork.

### 6. Fund, then re-check right before demoing

```bash
export OWNER_ADDRESS=0x...        # owner EOA (Mera-derived in the app)
export RELAYER_ADDRESS=0x...      # merchant/relayer that submits spends AND declines
export FUNDER_PRIVATE_KEY=0x...

npm run fund          # tops up anything below threshold
npm run fund:check    # balance table, no transactions
```

Run `fund:check` again immediately before presenting. **Declines cost the relayer gas too**, and the
demo deliberately triggers several — a relayer running dry mid-demo is the most preventable failure
in the room.

### 7. Live end-to-end run

```bash
npm run demo          # real transactions: issue → approve → 2 declines → revoke
```

Prints an explorer link per transaction. Do this **once before demoing**, so the trail judges inspect
already exists and the flow is rehearsed rather than improvised.

---

### Rollback

Contracts are not upgradeable by design. Redeploying means running steps 2–5 again; the old
deployment stays on-chain and inert. Cards issued under a previous deployment are not migrated —
issue fresh ones.
