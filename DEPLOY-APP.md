# Deploying the web app

## What it is, so your host does not guess wrong

**Next.js 16 (App Router), server-rendered.** Not Create React App, not a static site.

If a build log mentions `react-scripts`, the platform mis-detected the framework and is running
the wrong builder — that is the cause of errors like
`Cannot find module 'typescript' from .../node_modules`. Point the platform at the right commands:

| Setting | Value |
|---|---|
| Framework | Next.js |
| Install | `npm install` |
| Build | `npm run build` |
| Start | `npm run start` (honours `$PORT`) |
| Node | 20.9+ (`.nvmrc` and `engines.node` both declare it) |
| Output | **Server**, not static export |

`typescript` and the `@types/*` packages are listed under `dependencies`, not
`devDependencies`, precisely so a host that installs with `--omit=dev` can still build.

**It cannot be a static export.** Two route handlers need a Node runtime:

- `/api/relay` — submits the agent's signed authorisation and pays its gas
- `/api/fund` — sends a little MON to a brand-new passkey account so onboarding has no faucet detour

Everything else — all reads, all owner actions, all agent signing — happens in the browser against
a public RPC.

## Environment variables

Only two are required, and both are **testnet-only throwaway keys**:

```bash
RELAYER_PRIVATE_KEY=0x...   # pays gas for agent spends, including refusals
FUNDER_PRIVATE_KEY=0x...    # drips MON to new passkey accounts at onboarding
```

Optional:

```bash
MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz   # override the public RPC
```

**Do not set** `DEPLOYER_PRIVATE_KEY` or `OWNER_PRIVATE_KEY` on the host. The app never reads
them: deployment is a local operation, and the owner's key is derived from a passkey in the
browser and never exists on a server. They live in your local `.env` for scripts only.

Neither variable is prefixed `NEXT_PUBLIC_`, so neither is exposed to the browser. Keep it that
way — a `NEXT_PUBLIC_` private key would ship to every visitor.

### Funding those two accounts

Both need MON or the demo stalls:

```bash
npm run fund:check    # balances table
npm run fund          # top up anything below threshold
```

A full click-through costs roughly a dozen transactions. Refusals cost the relayer gas too — that
is the price of putting them on-chain — so check before a live run.

## HTTPS and passkeys: the one thing that will bite you

WebAuthn needs a secure context, so the deployed app must be served over **HTTPS** (platform
defaults are fine). More importantly:

> **A passkey is bound to the domain that created it.** A passkey made on `localhost` will not
> work on your deployed domain, and one made on a preview URL will not work on production.

So **create the passkey you intend to demo with on the exact domain you will present from**. If
previews get a new URL each deploy, each one is effectively a new account. Pin a stable domain for
anything you plan to show.

The provider also has to support the WebAuthn **PRF extension**: iCloud Keychain, 1Password, or
Google Password Manager. A passkey saved only into a desktop Chrome profile cannot derive an
account, and the app says so in plain language when that happens.

## After deploying

1. Open `/verify` — it needs no sign-in, so if it renders the record, reads are healthy.
2. Open `/settings` and create an account; confirm gas arrives (that exercises `/api/fund`).
3. On `/cards`, claim AUSD and approve, then issue a card.
4. Open the card and run Atlas — a settled payment plus two refusals exercises `/api/relay`.

If step 4 fails but 1–3 work, the relayer is the problem: check `RELAYER_PRIVATE_KEY` is set and
that the account has MON.

## Note on `contracts/`

The repo contains a Foundry project that is not part of the web build; `next.config.ts` already
excludes it from output tracing. Clone with submodules if you intend to run `forge test`:

```bash
git clone --recursive https://github.com/tantasui/darc.git
```
