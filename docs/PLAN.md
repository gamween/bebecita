# Implementation plan

Status at the time of writing: the contracts are deployed and verified on Ethereum Sepolia, gate zero is
green, 11 tests pass, six commits on `main`. What follows is everything left to build.

Every task ships on its own branch, through a pull request, reviewed before merge. No direct commits to
`main`.

## Ordering and dependencies

```
T1 pool and position  ──┐
                        ├──> T3 fill orchestrator ──> T5 two fills in one transaction
T2 frontend         ────┘                        └──> T6 dashboard and SLAC
T4 concentrate curve ───────────────────────────────┘
T7 docs and demo ──────────────────────────────────────────────> T8 final review
```

T1, T2 and T4 are independent and can run at the same time. T3 needs T1. T5 needs T3 and T4. T6 needs T3.

---

## T1. Pool and position, `feat/pool-position`

Create the pool and the liquidity position through the Uniswap API, give the position to the vault, and open
the Aqua strategy that the book quotes on.

Deliverables:
- `solver/src/setup.ts`, a script that calls `/lp/check_approval` with `generatePermitAsTransaction: true`,
  then `/lp/create` with `newPool`, using the two deployed test tokens.
- The position ends up owned by `BebecitaVault`. The vault already implements `onERC721Received`.
- `solver/src/aqua.ts`, which builds the SwapVM order and ships it from the vault. The strategy blob must be
  `abi.encode(order)` byte for byte, and the program must carry a fresh `Salt` on every run.
- The resulting addresses, tokenId and strategy hash written to `deployments/sepolia.json`.

Acceptance: `yarn setup` runs end to end on Sepolia, the vault owns a position with non-zero liquidity, and
`vault.reachableFromPosition()` returns a non-zero figure.

## T2. Frontend, `feat/frontend`

A landing page and an app, both real, with working buttons. The visual direction will be revised afterwards,
so structure and behaviour matter more than styling, but it must not look like a default template.

Deliverables:
- `app/`, a Vite plus React plus TypeScript project, wallet connection through viem.
- Landing page: what the product is, the removal test stated both ways, the live Sepolia addresses linked to
  Etherscan, and a call to action into the app.
- App page: the position on one side, the Aqua book on the other, and the working buttons: refresh state,
  request a quote, run a fill, claim fees. Every button hits the real chain or the real API.
- The network panel showing raw Uniswap API requests and responses with `x-ratelimit-remaining`, because an
  API integration has to be provable on screen.

Acceptance: `yarn dev` serves both pages, the buttons work against Sepolia, nothing is mocked.

## T3. Fill orchestrator, `feat/fill-orchestrator`

The piece that makes a fill happen.

Deliverables:
- `solver/src/fill.ts`: read the quote through `asView()`, size the unwind, round the percentage up because
  the API only accepts integers, call `/lp/decrease` and `/lp/increase`, place the two calldatas into the
  `preTransferOutHookData` and `postTransferInHookData` slices, and send the swap.
- Taker traits built in Solidity via `TakerTraitsLib.build` inside a Foundry script, not by hand.
  `IS_FIRST_TRANSFER_FROM_TAKER` stays at zero.
- A one command reset that re-salts, re-ships and refills, because a demo that cannot be replayed drops the
  1inch gate at the worst moment.

Acceptance: one command produces a green fill on Sepolia with a `Swapped` event and two PositionManager calls
in the same transaction, and it can be run twice in a row.

## T4. Concentrated curve, `feat/concentrate`

Move the program from `XYCSwap` `0x50` to `XYCConcentrateSwap` `0x51`, parameterised with the position's real
tick bounds read from `/lp/pool_info`.

Why: `XYCSwap` never clamps its output, while `XYCConcentrate` clamps on `balanceOut` and re-solves `amountIn`
in both directions since the partial fill work merged on 2026-07-22. So when `0x92` clamps below what the
taker asked for, the fill degrades into an exact partial instead of depending on luck. And the book's curve
becomes the range of the position funding it.

Acceptance: a fill larger than the reachable collateral returns an exact partial rather than reverting, proven
by a test.

## T5. Two fills in one transaction, `feat/two-fills`

A taker contract that calls `swap()` twice, on two strategy hashes of the same maker, both backed by the same
position. Legal because the reentrancy guard is keyed by order hash rather than global, and the second
`runLoop` reads a balance already reduced by the first pull.

Acceptance: one transaction hash on Sepolia showing two `Swapped` events and one position touched. Never
three, the setup cost is where demos die.

## T6. Dashboard and SLAC, `feat/dashboard`

Inside the app: three columns, Uniswap on one side with tokenId, tick and live liquidity read through
`StateView`, the vault in the middle with reserves and effective liquidity named as URC-3 names them, and Aqua
on the other side with the strategy hashes and their raw balances.

Plus the SLAC displayed twice, as defined on page 4 of the Aqua whitepaper: undefined against bare wallet
equity, because the vault holds nothing, and finite against float plus recoverable collateral, which is
exactly what the instruction computes.

Acceptance: the numbers move on their own while nobody touches anything.

## T7. Docs and demo, `docs/complete`

- `docs/ARCHITECTURE.md`: the settlement window, the four guards, the trust model.
- `docs/DEMO.md`: the three minute script, screen by screen, including the split screen negative moment
  against the official 1inch router already deployed at `0x8fdd04db...`.
- `docs/DECISIONS.md`: what was decided and why, including what was deliberately not built.
- One diagram in the README: five boxes, with `SwapVM.sol:310-314` and `:321` written on the arrow between
  the middle two.

## T8. Final review

A full read of the diff against both tracks' qualifying requirements, then the submission artefacts.
