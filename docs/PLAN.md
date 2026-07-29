# Implementation plan

This file was written before the build and is kept as the record of what was planned. It is not a status
report. Where a task shipped differently from the plan, or did not ship at all, that is written under the task
rather than edited out of it.

Status as of **2026-07-29**: the contracts are deployed and verified on Ethereum Sepolia, gate zero is green,
53 tests pass in three suites. Every build task shipped. T5 shipped last and after the event, which is written
under T5 along with the part of its original rationale that turned out to be wrong. Two submission artefacts
were never produced and are recorded as open in `docs/SUBMISSION.md`, under T8 below.

The repository's own counts are deliberately not frozen here. `git rev-list --count origin/main` and `gh pr
list --state merged --limit 100 --json number --jq 'length'` answer for the commits and the pull requests, and
a number copied into a file that itself lands through a pull request is wrong the moment it lands.

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

T1, T2 and T4 are independent and can run at the same time. T3 needs T1. T5 needed T3 and T4. T6 needs T3.

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

## T5. Two fills in one transaction, `feat/close-last-plan-task`. Shipped after the event.

Planned: a taker contract calling `swap()` twice, on two strategy hashes of the same maker, both backed by the
same position. Legal because the reentrancy guard is keyed by order hash rather than global, and the second
`runLoop` would read a balance already reduced by the first pull.

Why it was dropped at the time, plainly. It was the best ten seconds available on stage and it was ranked
below the work that closed a real security hole. The audit that produced guard five landed in the same window:
the first four guards let a taker unwind the whole per fill cap, hand the vault exactly what the fill owed and
keep the rest of both tokens, and repeating that with dust sized fills drained the position with every guard
green. Building a second taker to make the demo louder while that was open would have been the wrong trade. A
judge who asks what got cut should be told this, because the answer is the better story.

That ranking still reads correctly. The second reason written here, that T5 was theatre with no new mechanism
because the reentrancy guard is the sponsor's property, does not. The guard keying is what makes the
arrangement legal, and legality is not the experiment. The experiment is that Aqua reads a maker's balances
per order hash, so two strategies against one position are two promises with nothing relating them, and
instruction `0x92` is the only thing in the transaction that relates them. That is this project's mechanism
and nobody else's, and it was never executed against more than one fill at a time.

So it is built. `contracts/src/takers/BebecitaTaker.sol` is the taker, and it does two different things
because they are two different experiments. `fillAll` runs fills back to back. The `preTransferOutCallback`
path runs the second fill inside the first, in the window `SwapVM.sol:316-319` opens between the maker's
`preTransferOut` hook and `AQUA.pull`, which is the shape that actually needs the guard to be keyed by order
hash. Five tests in `contracts/test/Bebecita.t.sol` cover it, and the suite went from 48 to 53.

What they establish, in the order they were worth writing:

- Back to back, the second fill is paid exactly what the first one left. On the test position of 1,000
  liquidity the first fill is clamped to 475, unwinds the whole 500 cap, redeposits the 25 of surplus, and the
  second fill is then clamped to 249.375, which is `_reachable(525)` to the wei. Both strategies were shipped
  10,000 of virtual balance, so Aqua would have honoured either one of them alone.
- The per fill cap measures the position as it stands rather than as it was. Guard 3 reads liquidity at hook
  entry, so unwinding `maxUnwindPct` twice takes half and then half of the remainder, and iterating inside one
  transaction never reaches the whole position.
- Nested, both fills settle, and the log order proves the nesting: two `Swapped` events out of one call with
  the inner order's first.
- And the one interaction composition actually creates, which is the reason this was worth building rather
  than staging. `0x92` adds the maker's free float to the reachable share of the position, and inside the
  settlement window that float is the outer fill's own unwind, sitting in the vault because `AQUA.pull` has
  not run yet. So the inner fill is quoted 737.5 where its own share of the position is worth 237.5. Neither
  the reentrancy guard nor the cap stops a taker from asking for all of it: the inner unwind in that test is
  exactly `maxUnwindPct` of what is left. Guard 1 stops it, because it is a delta and not a level. It requires
  the payload to raise the maker's balance by the whole `amountOut`, so tokens that were already there when
  the hook started cannot fund a second payout. The transaction reverts, the maker pays nothing, and the taker
  pays the gas.

What is not claimed. This shipped as contracts and tests, against `MockPositionManager`, and nothing new was
sent to Sepolia for it. Every `Swapped` the deployed router has ever emitted, nineteen of them, still sits in
its own transaction, and the command below is how that is counted rather than remembered.

```bash
cast logs --from-block 0 --to-block latest \
  --address 0x354422f6e4e3476b540E306A6DdFb4638d9EA5c3 \
  0x54bc5c027d15d7aa8ae083f994ab4411d2f223291672ecd3a344f3d92dcaf8b2 \
  --rpc-url <an archive Sepolia endpoint>
```

## T6. Dashboard and SLAC, `feat/dashboard`

Inside the app: three columns, Uniswap on one side with tokenId, tick and live liquidity read through
`StateView`, the vault in the middle with reserves and effective liquidity named as URC-3 names them, and Aqua
on the other side with the strategy hashes and their raw balances.

Plus the SLAC displayed twice, as defined on page 4 of the Aqua whitepaper: undefined against bare wallet
equity, because the vault holds nothing, and finite against float plus recoverable collateral, which is
exactly what the instruction computes.

Acceptance: the numbers move on their own while nobody touches anything.

## T7. Docs and demo, `docs/complete`

- `docs/ARCHITECTURE.md`: the settlement window, the five guards, the trust model.
- `docs/DEMO.md`: the three minute script, screen by screen, including the split screen negative moment.
  Planned against the official 1inch router already deployed at `0x8fdd04db...`. That deployment does not
  execute orders built against current `swap-vm`, which became `FEEDBACK.md`'s strongest 1inch finding, so the
  negative moment shipped on our own router instead through `yarn negative-moment`. Same curve, same bounds,
  one instruction of difference, which is the more rigorous experiment anyway.
- `docs/DECISIONS.md`: what was decided and why, including what was deliberately not built.
- One diagram in the README: five boxes, with `SwapVM.sol:310-314` and `:321` written on the arrow between
  the middle two.

## T8. Final review

A full read of the diff against both tracks' qualifying requirements, then the submission artefacts.

The review happened and its outcome is `docs/SUBMISSION.md`, row by row. Two of the artefacts it lists were
never produced: the Uniswap Developer Feedback form was not filed, and the demo video was not recorded. They
are marked as such there rather than rounded up, and neither is a thing the repository can close on its own.
