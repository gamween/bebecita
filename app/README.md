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
| Run a fill | `src/lib/fill.ts`, the only stub. See below. |

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

## The one stub

`src/lib/fill.ts` exposes `runFill(request: FillRequest): Promise<FillResult>`, the signature the solver will
provide once T3 lands. The fill has to be signed by the key that owns the vault, so it runs in the solver
process rather than in a browser tab, and this module is the seam. Point `VITE_SOLVER_URL` at the solver HTTP
entry point and the button starts posting real fills. Until then it throws `FillNotWiredError` and the app
says so in the Aqua column instead of pretending a transaction happened.

## Environment

Optional, all read from the repository root `.env`:

- `UNISWAP_API_KEY`, used by the dev server proxy. Without it the gateway answers 401 and the panel shows it.
- `SEPOLIA_RPC_URL`, proxied at `/api/rpc` so a private endpoint stays out of the bundle. Without it the app
  falls back to public Sepolia endpoints.
- `VITE_SEPOLIA_RPC_URL`, an endpoint the browser may call directly.
- `VITE_SOLVER_URL`, the fill orchestrator.
