# app

The landing page and the dashboard. Vite, React, TypeScript, viem. No wallet kit, no component library, no
chart library: the wallet is `window.ethereum` driven through viem, and the styling is one CSS file.

```bash
cd app
yarn install
yarn dev            # http://localhost:5173
```

`yarn build` type checks and builds into `app/dist`. `yarn preview` serves that build with the same proxy as
the dev server.

## Where the numbers come from

Nothing is mocked. A value that cannot be read yet is displayed as unavailable, with the reason, which is the
honest state while the position is being created.

| Panel | Source |
|---|---|
| Uniswap column | `getPositionLiquidity(uint256)` and `getPoolAndPositionInfo(uint256)` on the v4 PositionManager, `getSlot0` and `getLiquidity` on StateView, plus `POST /lp/pool_info` on a manual refresh |
| Vault column | `getReserves`, `getEffectiveLiquidity` and `reachableFromPosition` on BebecitaVault, and `balanceOf` on both tokens |
| Aqua column | `rawBalances(maker, app, strategyHash, token)` on the official Aqua, plus `AQUA()` and `OPCODE_UNWIND_PRICED_BALANCE_OUT()` on the router |
| Request a quote | `quote()` on BebecitaRouter through a staticcall, with taker traits built the way `TakerTraitsLib.build` builds them |
| Claim fees | `POST /lp/claim_fees`, and the returned calldata can be executed through `vault.executeOnPositionManager` when the connected wallet is the vault owner |
| Build unwind calldata | `POST /lp/decrease`, the payload that goes into the `preTransferOutHookData` slice of a real fill |
| Run a fill | `POST /fill` on `yarn solver:serve`, which runs `solver/src/fill.ts`. See below |
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

Requests go to `/api/uniswap/lp/*` on the dev server, which attaches `x-api-key` from the repository `.env`
and forwards to `https://liquidity.api.uniswap.org`. The key never reaches the bundle. The proxy echoes the
real upstream URL back as `x-bebecita-upstream`, which is what the network panel displays, so the panel proves
where the request actually went. That also means the API buttons need `yarn dev` or `yarn preview`, not a
plain static server.

Two things the live gateway taught us, both worth a line in FEEDBACK.md:

- `/lp/decrease` and `/lp/increase` name the position `nftTokenId` and want it as a **string**. Sending a
  number fails with `cannot decode field uniswap.liquidity.v2.DecreasePositionRequest.nft_token_id from JSON`.
- `/lp/claim_fees` names the same thing `tokenId`. Sending `nftTokenId` there fails with
  `ClaimFeesRequest validation error: "tokenId" is not allowed to be empty`.
- `x-ratelimit-remaining` is not returned on every response. `/lp/pool_info` 200s carry no rate limit header,
  while `/lp/claim_fees` and `/lp/decrease` do. The panel shows the whole response header block for that
  reason, and highlights the rate limit value whenever the gateway sends one.

## The fill button

The fill is signed by the key that owns the vault, so it runs in a process and not in a tab. `src/lib/fill.ts`
is the client for that process:

```bash
yarn solver:serve      # at the repository root, listens on 127.0.0.1:8787
```

The app posts to `VITE_SOLVER_URL` when the operator set one, and to `/api/solver` otherwise, which the dev
server proxies to the same place. So the default needs no configuration and no CORS.

`POST /fill` answers with newline delimited JSON, one event per line, and the page renders the six steps as
they arrive rather than showing a spinner for forty seconds. The last event carries the transaction hash, and
everything shown about the fill after that is decoded from the receipt rather than repeated from the solver:
the `Swapped` amounts, then the two PositionManager calls with the position's liquidity before and after each,
derived from `Unwound`, `Redeposited` and the PoolManager's two `ModifyLiquidity` events.

The **dry** box next to the button runs `yarn fill --dry`, which simulates against live state and broadcasts
nothing. Useful to rehearse the demo without spending a strategy.

When no solver answers, `runFill` throws `FillNotWiredError`, the chip in the action bar reads `solver down`,
and the card names the URL it tried and the command that starts one. It never pretends a transaction happened.

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

- `UNISWAP_API_KEY`, used by the dev server proxy. Without it the gateway answers 401 and the panel shows it.
- `SEPOLIA_RPC_URL`, proxied at `/api/rpc` so a private endpoint stays out of the bundle. Without it the app
  falls back to public Sepolia endpoints.
- `VITE_SEPOLIA_RPC_URL`, an endpoint the browser may call directly.
- `SOLVER_URL`, where the dev server proxies `/api/solver`. Defaults to `http://127.0.0.1:8787`.
- `VITE_SOLVER_URL`, a solver the browser posts to directly instead, bypassing the proxy.

## Polling

Chain state every 5 seconds, the log scan every 60, the solver health probe every 20. `POST /lp/pool_info` is
never on a timer: it goes out on **Refresh state**, at most once every 15 seconds, because the Uniswap key
allows six requests a second and a demo should not spend that on a render loop.
