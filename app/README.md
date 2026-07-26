# app

The landing page and the dashboard. Vite, React, TypeScript, viem, wagmi. No component library, no chart
library, no animation library: the styling is one CSS file and the wallet is wagmi over viem clients.

Deployed at **https://bebecita-fh121iw64-gamween-7559s-projects.vercel.app**, with both proxies live as
serverless functions. See the Deployment section of `docs/ARCHITECTURE.md`.

```bash
cd app
yarn install
yarn dev            # http://localhost:5173
```

`yarn build` type checks and builds into `app/dist`. `yarn preview` serves that build with the same proxy as
the dev server. Run both from inside `app`: yarn 3.2.3 applies `--cwd` twice and then looks for `app/app`.

## The wallet

wagmi owns the connection, the account, the chain and the reconnect. viem stays underneath, because the rest
of this codebase is viem: every client wagmi hands back is a viem client, and the read transport is the same
`fallback` over the same endpoints the dashboard uses, declared once in `src/lib/client.ts`.

Three connectors, and the set is decided at load time rather than guessed at:

| Connector | Condition | Why |
|---|---|---|
| injected | always, plus one per extension that announces itself over EIP-6963 | an extension keeps working, and the chooser can say Rabby or MetaMask instead of "browser wallet" |
| Coinbase Wallet | always | one dependency, no configuration, and a judge with no extension installed still has a way in |
| WalletConnect | only when `VITE_WALLETCONNECT_PROJECT_ID` is set | a phone wallet can scan a code and take a fill |

The generic injected entry is dropped from the chooser when at least one extension announced itself, because
both would be offered and both would do the same thing. When none does, it is kept, because it is the only
entry that can reach an extension which does not announce itself.

Without the project id, WalletConnect is absent rather than broken. The chooser says so in one line, and
there is no button that opens a modal and then fails.

What the button does:

- one connector available, it connects. Several, it opens a chooser naming each one;
- connected, it shows the address truncated and the connector's name, and opens a panel with the full address,
  a copy action, an Etherscan link and a disconnect;
- an account switch or a chain switch made inside the wallet lands on the page through wagmi's own hooks, with
  no reload;
- on the wrong chain, the button says which chain and offers the switch. A wallet that has never heard of
  Sepolia gets `wallet_addEthereumChain` with this app's own endpoints, which is wagmi's 4902 fallback;
- on reload, wagmi reconnects to whichever connector this browser already authorised, and to none if it was
  disconnected here.

Every transaction the page sends has four states rather than a spinner: waiting on the wallet, sent, confirmed
in a block, failed. The hash is a link from the instant it exists and stays one through a revert, because a
reverted transaction has a receipt and that receipt is the useful thing. A revert is decoded to the custom
error the guard raised rather than printed as a viem error object, and a rejection in the wallet says it was
rejected and that nothing was sent.

## Where the numbers come from

Nothing is mocked. A value that cannot be read yet is displayed as unavailable, with the reason, which is the
honest state while the position is being created. A reason that covers several fields is stated once, at the
top of the page, and those fields render as quiet placeholders under it, so a page that has not loaded reads
as one page loading rather than as twenty five broken fields. Loading and failed are two different banners.

| Panel | Source |
|---|---|
| Uniswap column | `getPositionLiquidity(uint256)` and `getPoolAndPositionInfo(uint256)` on the v4 PositionManager, `getSlot0` and `getLiquidity` on StateView, plus `POST /lp/pool_info` on a manual refresh |
| Vault column | `getReserves`, `getEffectiveLiquidity` and `reachableFromPosition` on BebecitaVault, and `balanceOf` on both tokens |
| Aqua column | `rawBalances(maker, app, strategyHash, token)` on the official Aqua, plus `AQUA()` and `OPCODE_UNWIND_PRICED_BALANCE_OUT()` on the router |
| Request a quote | `quote()` on BebecitaRouter through a staticcall, with taker traits built the way `TakerTraitsLib.build` builds them |
| Claim fees | `POST /lp/claim_fees`, and the returned calldata can be executed through `vault.executeOnPositionManager` when the connected wallet is the vault owner |
| Build unwind calldata | `POST /lp/decrease`, the payload that goes into the `preTransferOutHookData` slice of a real fill |
| Run a fill | `solver/src/fillPlan.ts` and `solver/src/takerTraits.ts`, in this tab, then `swap()` through the connected wallet. See below |
| Mint and Approve | `TestERC20.mint` and `approve`, from the connected wallet, so the taker can fund itself |
| The fill, after it lands | the transaction's own receipt: `Swapped` from the router, `Unwound` and `Redeposited` from the vault, `ModifyLiquidity` from the PoolManager |
| Settled volume, and every strategy | `eth_getLogs`, `Swapped` on the router and `Shipped` on the vault, over a bounded window |
| SLAC | the sum of `rawBalances` over every strategy found, over two denominators, both read on chain |

## Addresses

The app keeps no copy of any address. Two files are fetched at runtime:

- `/deployments/sepolia.json`, served straight from `deployments/sepolia.json`, which the deploy and setup
  scripts write. A new tokenId or strategy hash therefore shows up on a page refresh, with no rebuild.
- `/deployments/chain.json`, lifted out of the `SEPOLIA` literal in `solver/src/config.ts` by the Vite plugin
  in `vite.config.ts`, because that file imports dotenv and cannot be bundled for a browser.

Both are emitted into `dist` at build time, so a built copy stays self contained.

## The Uniswap API key

Requests go to `/api/uniswap/lp/*`, which attaches `x-api-key` and forwards to
`https://liquidity.api.uniswap.org`. The key never reaches the bundle. The proxy echoes the real upstream URL
back as `x-bebecita-upstream` and whether a key was attached as `x-bebecita-api-key`, which is what the network
panel displays, so the panel proves where the request actually went instead of asserting it.

That proxy exists twice: Vite middleware under `yarn dev` and `yarn preview`, and `api/uniswap.ts` as a
serverless function in production. `/api/rpc` is the same arrangement for JSON-RPC. So the API buttons work on
the deployed site and on a dev server, and nowhere else: a plain static server has no proxy and the panel will
say so.

Two things the live gateway taught us, both worth a line in FEEDBACK.md:

- `/lp/decrease` and `/lp/increase` name the position `nftTokenId` and want it as a **string**. Sending a
  number fails with `cannot decode field uniswap.liquidity.v2.DecreasePositionRequest.nft_token_id from JSON`.
- `/lp/claim_fees` names the same thing `tokenId`. Sending `nftTokenId` there fails with
  `ClaimFeesRequest validation error: "tokenId" is not allowed to be empty`.
- `x-ratelimit-remaining` is not returned on every response. `/lp/pool_info` 200s carry no rate limit header,
  while `/lp/claim_fees` and `/lp/decrease` do. The panel shows the whole response header block for that
  reason, and highlights the rate limit value whenever the gateway sends one.

## The fill button

The fill runs here, in the tab, signed by the connected wallet. There is no backend to start: one port, one
command, `yarn dev`.

`src/lib/fill.ts` is only the browser half of the environment the fill needs. The fill itself is
`solver/src/fillPlan.ts`, imported from outside this package through the `@solver` alias declared in
`vite.config.ts` and `tsconfig.json`, and it is the same module `yarn fill` runs at the repository root. This
file supplies it with three things: chain reads through viem, the two Uniswap calls through the dev server
proxy, and `swap()` through the wallet client wagmi built over whichever connector is connected.

The taker traits come from `solver/src/takerTraits.ts`, a port of the sponsor's `TakerTraitsLib.build`.
`contracts/test/TakerTraits.t.sol` proves that port byte for byte against the library itself, which is what
made deleting the backend possible: the builder is `internal pure` Solidity and `forge` does not run in a
browser, and that single fact was the whole reason a process existed.

The six steps are reported as they happen rather than as a spinner. The transaction hash is the only thing
carried forward: everything shown about the fill afterwards is decoded from the receipt, the `Swapped`
amounts, then the two PositionManager calls with the position's liquidity before and after each, derived from
`Unwound`, `Redeposited` and the PoolManager's two `ModifyLiquidity` events.

The **dry** box next to the button does everything except sign: it quotes, calls both Uniswap endpoints,
encodes the traits and simulates `swap()` against live state through `eth_call`. Useful to rehearse the demo
without spending a strategy, and it is also how a fill that cannot settle explains itself before a nonce is
spent.

## Mint and Approve

The connected wallet is the taker, so it needs the input token and an allowance. Both are one button away:

- **Mint** calls `TestERC20.mint`, which is public on the demo pair on purpose, and sends 10 000 tokens to the
  connected wallet;
- **Approve the router** approves the router and not Aqua. `useTransferFromAndAquaPush` is set in the taker
  traits, so the router pulls `tokenIn` from the taker and pushes it into Aqua on the taker's behalf. An
  allowance to Aqua would leave the swap reverting inside the push with an ERC20 error naming neither
  contract.

Both run through the same four state transaction reporting as the fill, and the taker's balance and allowance
are read back from the chain next to them. That is what makes the demo self serve: a judge can fill against
this maker from their own wallet, and the maker's five on-chain guards are what make an unknown taker
harmless. The fifth, `UnwindValueDiverted`, is the one that matters for a taker nobody vetted: it requires the
value the unwind released to land in this vault rather than wherever the taker's payload named. See
`docs/ARCHITECTURE.md`.

## SLAC

The Shared Liquidity Amplification Coefficient, defined on page 4 of the Aqua whitepaper as the total
liquidity provisioned across all strategies over the wallet equity backing it. The numerator sums
`rawBalances(maker, app, strategyHash, token)` over every strategy hash the vault has shipped, found from its
own `Shipped` events rather than from the deployment record, which only names the live one. It is displayed
against two denominators:

- the vault's plain ERC20 balances, which is what a wallet balance check sees. Enormous, and rendered as
  undefined with the reason when the float is zero, which is a legitimate state here and not a crash;
- free float plus `vault.reachableFromPosition()`, counted once because one fill leans on the position once.
  That is the figure instruction `0x92` computes on chain and clamps the quote to.

Both tokens carry 18 decimals, so the sums are counts of tokens rather than valuations, and the page says so.

## Reading logs from a public endpoint

`eth_getLogs` is chunked into 9 000 block ranges, under the smallest cap the fallback endpoints enforce: drpc
allows 10 000 on its free tier, publicnode allows 50 000 but refuses historical logs outright, and viem's
fallback transport moves on when one answers with an error. The scan walks backwards from the head over about
45 000 blocks, keeps whatever it read, and reports the oldest block it actually reached, so a strategy shipped
before that window is labelled as coming from the deployment record instead of being silently omitted.

## Environment

Optional, all read from the repository root `.env`, which is where `envDir` in `vite.config.ts` points, so the
frontend and the solver share one file. Only `VITE_` prefixed variables reach the bundle.

- `UNISWAP_API_KEY`, used by the proxy, from `.env` locally and from the project's environment variables on the
  deployment. Without it the gateway answers 401, the panel shows it, and `x-bebecita-api-key` reads `missing`.
- `SEPOLIA_RPC_URL`, proxied at `/api/rpc` so a private endpoint stays out of the bundle. Without it the app
  falls back to public Sepolia endpoints.
- `VITE_SEPOLIA_RPC_URL`, an endpoint the browser may call directly.
- `VITE_WALLETCONNECT_PROJECT_ID`, self serve and free at https://cloud.reown.com. Set it and the connect
  chooser offers WalletConnect next to the injected and Coinbase Wallet connectors. Leave it empty and
  WalletConnect is simply not registered, which the chooser says in one line. Nothing else changes and no
  button breaks. The id identifies the dapp rather than a user, so it is safe in a bundle.

Nothing else. There is no solver to point at.

## Polling

Chain state every 5 seconds, the log scan every 60, and the taker's balance and allowance on the same tick as
the state. The block number in the top bar is wagmi watching the head on the same 5 second interval, which is
the only timer the top bar owns. `POST /lp/pool_info` is never on a timer: it goes out on **Refresh state**,
at most once every 15 seconds, because the Uniswap key allows six requests a second and a demo should not
spend that on a render loop. The two calls a fill makes are the only other API traffic, and they go out once
per press.
