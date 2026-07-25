# Architecture

## The one property everything rests on

Aqua never custodies anything.

Opening a strategy is not a deposit. `Aqua.ship` writes a number into
`_balances[maker][app][strategyHash][token]` and performs no solvency check of any kind: it does not look at
the maker's wallet, it does not sum what the maker has already promised elsewhere, and it moves no tokens.
`Aqua.pull` then decrements that number and only afterwards calls `safeTransferFrom` on the maker's wallet.

So Aqua does not require a maker to keep funds available. It requires one transfer to succeed on the last
line. The money only has to exist for the width of a couple of instructions, which is why it can be working
somewhere else until then.

Say it that way, always. The position is the collateral, and settlement converts it just in time, made safe by
atomicity. Never say the same money is in two places at once, because it never is.

## The settlement window

`SwapVM` runs the whole program before any token moves, then transfers. The order of transfers depends on the
taker's `IS_FIRST_TRANSFER_FROM_TAKER` flag, and both orders matter here.

With the flag set, `SwapVM.sol:224-226`:

```
preTransferIn  :237-241
taker callback :243-246
AQUA.push      :262
postTransferIn :282-286
preTransferOut :310-314
taker callback :316-319
AQUA.pull      :321 -> :341 -> Aqua.sol:63-70
postTransferOut:323-327
```

With the flag unset, `SwapVM.sol:227-229`, the two halves swap: `preTransferOut`, callback, pull,
`postTransferOut`, then `preTransferIn`, callback, push, `postTransferIn`.

Two facts follow, and the whole design is built on them.

`preTransferOut` always immediately precedes the pull. It is therefore the only point in the system guaranteed
to run just before tokens leave the maker, in either ordering. That is the funding window.

`postTransferIn` is the only hook that always runs after the push. It is therefore the only place where a
redeposit can be funded with the taker's input.

We pin `IS_FIRST_TRANSFER_FROM_TAKER` to zero, which forces the second ordering. That places `postTransferIn`
after the pull, which makes a two sided redeposit legal, which keeps the position in range, which is the only
way it earns fees. Flipping that bit silently changes everything.

## The instruction

`_unwindPricedBalanceOut1D`, opcode `0x92`, balances tuning bank.

```
balanceOut = min(balanceOut, float + reachable)
float      = IERC20(tokenOut).balanceOf(maker)
reachable  = liquidity x unitsPerLiquidity x maxUnwindPct x (1 - haircut)
```

Three rules that are not negotiable and that the code comments repeat:

It clamps, it never assigns. Writing a value above the shipped Aqua balance would price a fill that
`Aqua.pull` cannot honour, and the underflow would revert after the entire program had run.

It never touches `balanceIn`. On the constant product curves wired into the Aqua table, lowering `balanceIn`
raises the payout, so an instruction that touched it would quote more generously exactly when the maker is
less solvent.

It is `view`. It writes no storage, so `isStaticContext` is irrelevant to it and quote/swap consistency, the
only invariant of the core suite that cannot be skipped, holds structurally rather than by discipline.

Its position guard, `require(amountIn == 0 || amountOut == 0)`, mirrors `Decay`, `Fee` and `MinRate`, and
forces it to sit before the curve.

## The curve

`XYCConcentrateSwap`, opcode `0x51`, dispatched by `AquaOpcodes` itself. The program is
`[0x92 unwind][0x51 concentrate][0x02 salt]`, and the order of the first two is forced from both ends: `0x92`
requires both amount registers to still be zero, and `0x51` is terminal and reads `balanceOut` after the clamp.

Two things follow from choosing it over `XYCSwap`, `0x50`.

`0x50` never clamps its own output. Instruction `0x92` exists to lower `balanceOut` to what the position can
release, and `0x50` will happily be asked for more than that: in exact-out it computes
`amountIn = ceilDiv(amountOut * balanceIn, balanceOut - amountOut)`, which underflows above the balance and
divides by zero at it, so the taker gets an arithmetic panic with nothing in the revert data naming the cause.
`XYCConcentrate` clamps on `balanceOut` and re-solves the other side for the clamped amount, in both
directions, which turns that moment into an exact partial. This is not a tolerated accident:
`TakerTraitsLib.validate` requires `takerAmount >= amountIn` on exact-in and `takerAmount >= amountOut` on
exact-out, never equality, so the sponsor's own validation is written for partial fills.

Its two arguments are the position. `sqrtPriceMin` and `sqrtPriceMax` come from the position's tick bounds and
the live `sqrtRatioX96` of `POST /lp/pool_info`, and they are compiled into the program bytes at ship time.
The book's curve is the range of the Uniswap position funding it, and a maker who re-ranges the position
re-ranges the book.

The one caveat, stated rather than hidden. This position is full range and full range does not survive the
instruction's 1e18 fixed point: `sqrt(1.0001^-887220)` is `5.4e-20`, which truncates to zero, and
`XYCConcentrateArgsBuilder.build2D` rejects a zero lower bound. The shipped bounds are therefore the position's
range clamped to the widest window the format carries, a factor of `1e9` on the sqrt price either side of the
live spot, ticks `-414486` to `414486`. At that width the virtual reserves add a billionth of the real ones, so
the curve is constant product to nine significant digits: the clamp is what changed, not the price. The
consequence to know is that the exact-in half of the clamp is out of reach on a full range book, because a
constant product curve never pays out its whole reserve, and that the exact-out half is not.

The conversion from tick to sqrt price happens in the solver, in double precision, and `solver/src/aqua.ts`
says why: it defines the shape of a curve rather than settling anything, the value is recorded in
`deployments/sepolia.json` and rebuilt from that record rather than recomputed, and the tokens behind any
amount it prices are checked against the realised balance delta by the vault's first guard.

## The vault and the trust model

The withdrawal calldata comes from the taker, once per fill, because the Uniswap API builds it against live
chain state and it cannot be frozen into an immutable order. That is a real exposure and the vault treats it
as one.

The vault pins the callee to the position manager and pins the selector to the two `modifyLiquidities` entry
points. Beyond that it does not attempt to decode the payload, because the real API returns v4 Actions bytes
and any decoder we wrote would be a second implementation to get wrong. Instead it judges the payload by its
effects, and it has the numbers to do so because `preTransferOut` receives `amountOut` as a parameter.

Four guards:

1. after the unwind, the output balance must have grown by at least `amountOut`. A floor, not a sign check.
2. the input side balance may not shrink, so a payload cannot drain the other half of the book.
3. the position's liquidity may not fall by more than `maxUnwindPct`, so one fill cannot empty the collateral.
4. a redeposit may only grow the position.

A taker therefore chooses how to unwind and never whether the maker ends up short.

## URC-3

The vault implements `IHookStats` from URC-3, published by Uniswap Labs on 2026-06-11. The standard's
normative invariant is that `getEffectiveLiquidity` should not exceed `getReserves`, and instruction `0x92` is
that invariant enforced inside a virtual machine one instruction before settlement rather than merely reported.

URC-3's motivating cases name, verbatim, deploying liquidity in external protocols, rehypothecating assets and
maintaining reserves outside the PoolManager. This vault does all three.

The standard is scoped to v4 hooks and makes `hook()` mandatory for conformance, which does not fit a contract
that holds reserves without being a hook. We return the zero address and reported the gap upstream in
`FEEDBACK.md` rather than pretending it fits.

## What we deliberately did not build

The instruction is not a wrapper. Turning it into one, calling `ctx.runLoop()` from inside and post processing
the result, would let it compute the exact unwind percentage instead of taking a maker parameter. It was
considered and rejected: it puts the single component on the critical path under the knife for a gain that
does not show on screen, and the security argument it buys is already paid by guard one, which enforces a
floor rather than a sign.

There is no second instruction for minimum fill size. The answer to a thin looking contribution is a composed
program, not a second opcode, and the sponsor's own whitepaper calls the alternative a monolith.

`Decay` is not in the program stack. Its own NatSpec announces a quote versus swap divergence, and quote/swap
consistency is the one invariant we claim structurally.

Tick math is not reproduced on chain. The conversion from position liquidity to output units is a conservative
maker parameter, and the real figure is enforced after the fact by the hook's delta check. Reimplementing v4
pricing in view would be a night of work for a number the guards already verify.
