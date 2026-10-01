/** Monad Testnet parameters. Verified via `cast chain-id`, never guessed. */
export const MONAD_TESTNET = {
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: {
    default: { name: "MonadVision", url: "https://testnet.monadvision.com" },
  },
  testnet: true,
} as const;

/**
 * Canonical ERC-8004 registries on Monad Testnet.
 *
 * NOT the addresses in Monad's ERC-8004 guide -- those are the MAINNET singletons and
 * have no code on chain 10143. See README "Whose registries are these?" for provenance:
 * deployed by the ERC-8004 project via the SAFE Singleton Factory, UUPS proxies owned by
 * 0x547289319C3e6aedB179C0b8e8aF0B5ACd062603.
 */
export const ERC8004 = {
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
} as const;

/**
 * Real AUSD on Monad Testnet — Agora's dollar stablecoin, not a mock we minted. Six
 * decimals, which is why SpendGate's single-pinned-token design fits it exactly.
 *
 * The faucet is a proxy; its implementation exposes `requestFunds(address)`, which sends
 * 10,000 AUSD with a short cooldown. Neither contract is ours.
 */
export const AUSD = {
  token: "0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC",
  faucet: "0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C",
  decimals: 6,
  symbol: "AUSD",
} as const;

/** The token every card is denominated in. */
export const PAYMENT_TOKEN = AUSD.token;

export const RPC_URL = process.env.MONAD_TESTNET_RPC ?? MONAD_TESTNET.rpcUrls.default.http[0];

/**
 * Monad charges the DECLARED gasLimit, not gas used, so we set explicit, sane values
 * rather than padded estimates.
 */
export const GAS = {
  transfer: 21_000n,
} as const;
