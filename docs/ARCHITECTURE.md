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

`preTransferOut` is the last maker controlled point before the pull, in either ordering. That is the funding
window. It is not the statement immediately before it, and the trace above says so in its own lines: the taker
callback at `:316-319` sits in between. That callback runs only when the taker sets
`hasPreTransferOutCallback`, and what it runs is the taker's own code, so it can neither be relied on nor be
surprised by. Which is the reason the vault's guards measure realised balances instead of trusting a
sequence.

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

It is `view`. It writes no storage, so `isStaticContext` is irrelevant to it and quote/swap consistency holds
structurally rather than by discipline. That is one of the two invariants of the core suite that are never
skipped: `CoreInvariants.t.sol` gives symmetry, monotonicity, additivity and spot price a skip flag each, and
gives quote/swap consistency and balance sufficiency none. Balance sufficiency is what this instruction is
about, so the two invariants nobody may turn off are the two this project is built on.

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

Five guards, each with the error it raises, because a revert that names its own guard is the difference between
a diagnosis and an afternoon:

1. `UnwindShortfall`. After the unwind, the output balance must have grown by at least `amountOut`. A floor,
   not a sign check.
2. `CollateralLeak`. The input side balance may not shrink, so a payload cannot drain the other half of the
   book.
3. `UnwindExceedsCap`. The position's liquidity may not fall by more than `maxUnwindPct`, so one fill cannot
   empty the collateral.
4. `RedepositReducedPosition`. A redeposit may only grow the position.
5. `UnwindValueDiverted`. The value the unwind released must land in the vault, within `haircutBps`.

The fifth exists because the first four are not enough, and saying why is more useful than listing it.

None of the first four can see where the released tokens went. `modifyLiquidities` composes v4 Actions freely,
so `DECREASE_LIQUIDITY` followed by `TAKE` with arbitrary recipients lets a taker unwind the entire per fill
cap, hand the vault exactly `amountOut` and keep the rest of both tokens. Guard 1 is met exactly, because a
floor asks for nothing more. Guard 2 is met with equality, because the released tokenIn never arrives and a
balance that does not move cannot fall. Guard 3 is met at the cap, because it bounds liquidity and not value.
Repeat with dust sized fills and the position drains at `maxUnwindPct` per fill, with every guard green.

Guard 5 prices the liquidity actually removed into both tokens and compares it against what the vault gained.
That needs three things the vault previously had no way to obtain: the live pool price, the position's tick
bounds, and the conversion from liquidity to amounts. The first two are read on chain, from
`StateView.getSlot0` and `PositionManager.getPoolAndPositionInfo`, both hardened the way `_positionLiquidity`
and `Fee.sol:148-160` are, with pinned return lengths and no fail open path inside a hook. The third is
`contracts/src/libraries/LiquidityAmounts.sol`.

That file is vendored, which is a thing worth defending rather than doing quietly. It carries two libraries,
`TickMath` and `LiquidityAmounts`, and both are the Uniswap core routines reproduced unmodified in behaviour:
tick to sqrt price, and liquidity to per token amounts with its three cases for a price below, inside or above
the range. Neither is reachable through this repository's dependency tree. The only Uniswap package
`node_modules` carries is `@uniswap/permit2-sdk`, which is TypeScript, and `remappings.txt` names five remaps,
none of them a v4 one. Pulling in v4-core or v4-periphery for two pure functions would add a Solidity
dependency graph an order of magnitude larger than this project, on a build that already pays four minutes to
`via_ir`, and it would pin this project to a v4 release train it has no other reason to track.

Vendoring a routine is only acceptable if the copy is checked, so it is. `contracts/test/LiquidityAmounts.t.sol`
is sixteen tests against published constants and against the boundary cases, and the conversion factor it
produces was cross checked against the one `yarn rebalance` measured on Sepolia from real balances. The choice
is recorded in `docs/DECISIONS.md`, including what would make it wrong.

The tolerance is `haircutBps` rather than a knob of its own. The haircut already says how much slack the maker
accepts between what the position is worth and what it will count on, and one number that means one thing
survives a demo better than two that drift apart.

A taker therefore chooses how to unwind and never whether the maker ends up short, nor where the released
collateral lands.

## Two reachable figures, and why they are deliberately not one

The vault exposes the same quantity twice, and the duplication is the design rather than an oversight.

`reachableFromPosition()` is a mirror of the instruction. It computes `liquidity * unitsPerLiquidityE18`,
capped and haircut, which is exactly the arithmetic `0x92` performs inside the VM. It is a single scalar, it
reads no pool price, and it is `view` and cheap for the same reason the instruction has to be. Its purpose is
that the dashboard, the tests and the quote all read the same number the VM will clamp to. If it ever disagreed
with the instruction, the instruction would be the thing that was wrong.

`reachableAmounts(PoolKey)` is the on-chain truth. It prices the position's real liquidity into both tokens at
the live pool price through `StateView.getSlot0` and the position's own tick bounds, then applies the same cap
and haircut. It returns two numbers, not one, because a unit of full range liquidity is worth `sqrt(price)` of
token1 and `1/sqrt(price)` of token0 and those are only equal at parity.

Keeping both is what makes the drift visible instead of silent. `unitsPerLiquidityE18` is a maker parameter
compiled into the order at ship time, so it is exact when the book is shipped and decays as the pool moves.
`reachableAmounts` does not decay, because it reads the price. The gap between them is the maker's staleness,
measurable at any block with two `cast call`s, and the fix when it opens is to re-ship with the measured factor
and `setRiskParams` to match.

Read at block 11351549, after the last re-ship, the two agreed to twelve significant figures:
`reachableFromPosition()` returned `21237223594691144907326` and the token1 side of `reachableAmounts` returned
`21237223594691145042531`, a difference of 1.4e-13 bALPHA. That is what a freshly shipped book looks like. The
run before the last rebalance is what a stale one looks like, and it is recorded in the Inventory section
below.

Collapsing the two into one accessor was considered. Using only `reachableAmounts` would put a pool price read
inside `0x92`, which is on the critical path of every quote and every fill, for a number the guards already
verify after the fact. Using only `reachableFromPosition` is what the vault did before the conservation guard,
and it is precisely why guard five could not be written: a scalar in the instruction's own units cannot be
compared against two token balances.

## Deployment

The app is deployed and public at https://bebecita-fh121iw64-gamween-7559s-projects.vercel.app.

It matters that the deployed thing is the whole app rather than a static build with dead buttons. Two of this
project's demonstrations run through a proxy: the Uniswap LP calls, which need an `x-api-key` that must not
reach a bundle, and the JSON-RPC reads, which want an endpoint that is not a public one. In development both
are Vite middleware. A plain static deploy of `app/dist` would have shipped a page whose API panel returns 401
and whose chain reads fall back to whatever public endpoint answers, which is worse than no deployment because
it looks like the project rather than being it.

So both halves exist twice, and `api/` holds the serverless copies:

| Route | Function | What it does |
|---|---|---|
| `/api/uniswap/lp/*` | `api/uniswap.ts` | attaches `UNISWAP_API_KEY` and forwards to `https://liquidity.api.uniswap.org`, echoing the real upstream URL back as `x-bebecita-upstream` and whether a key was attached as `x-bebecita-api-key` |
| `/api/rpc` | `api/rpc.ts` | forwards JSON-RPC to `SEPOLIA_RPC_URL`, so a private endpoint stays out of the bundle |

The two response headers are not decoration. The dashboard's network panel displays them, which is what makes
the panel proof of where a request went rather than a claim about it. A judge can run the same check from a
terminal, and `docs/SUBMISSION.md` carries the two `curl` commands.

One deployment detail worth recording because it cost time. `vercel.json` routes `/api/uniswap/:path*` to
`/api/uniswap?path=:path*` with an explicit rewrite rather than relying on a catch-all filename, and its
`installCommand` installs both yarn projects, because the root install alone leaves `app/node_modules` empty
and the build fails on the first import.

A fill moves both tokens and it does not move them symmetrically.

`/lp/decrease` returns both sides of the position pro rata, because that is what removing liquidity from a v4
position does. The fill then pays the taker in one token only and is paid by the taker in the other. So a fill
in one direction leaves the vault holding more of the token the taker paid with, less of the token the taker
was paid in, and a position smaller by whatever the unwind removed. The redeposit that follows is two sided,
and a two sided deposit is capped by whichever token is scarce, which is the one the maker keeps selling. It
can put back a fraction of what came out and no more.

The numbers, all read off receipts by `yarn inventory` rather than modelled, and re-derived from the router's
own `Swapped` logs for this document. Fifteen fills in one direction removed 14,693.99 units of liquidity from
the position and put 5,856.54 back, which is 39.86%, and the shape behind that average is the part worth
reading. Cumulatively the first five fills restored between 95.7% and 97.2%, because the book was quoting
almost nothing out and the unwind's own output came straight back into the position. Once the book quoted near
parity, the per fill restore rate fell to between 4.6% and 17.8% and stayed in that band. Over the same fifteen
fills the vault accumulated 23,947.10 bBRAVO of free float.

The position figure needs one more word of precision, because the rebalance interleaves with the fills. After
fourteen fills the position stood at 92,140.39 of liquidity against the 100,000 it opened with, and the vault
held 21,859.61 bBRAVO. That is the state the rebalance below was run against, and `deployments/sepolia.json`
records exactly those numbers under `rebalance.before`, which is why they are the ones to quote.

That is not a defect being reported. It is the definition of a market maker seeing one sided flow: it is buying
what the market is selling, and inventory is what buying looks like while nobody is buying back. Every market
maker that has ever existed has had this problem and the answer has always been the same, which is to trade the
inventory home and to charge a spread wide enough to pay for that trade. The round trip through this book is
not balance neutral without that step, and the spread the maker earns has to cover the eventual cost of the
trade home rather than only the gas of the fill.

`yarn rebalance` is that step. It reads the vault's float on both tokens and the position's liquidity, sizes
the sale that leaves the remaining float and the sale's proceeds in the pool's own post trade ratio, sweeps
only that leg out to the owner, sells it through `POST /quote` and `POST /swap` on the trade host, sends the
proceeds back, and tops the position up through `/lp/increase` executed by the vault. The target is stated
rather than implied: the position back toward the liquidity it opened with, and the float back to near zero,
which is the state this whole project claims. Measured on Sepolia, one run took the float from 21,859.61
bBRAVO and 2.07 bALPHA to 35.73 and 0.93, and the position from 92,140.39 of liquidity to 102,473.62, which is
102.47% of what it opened with.

It runs between fills and never inside one. Nothing about the fill changed to make this possible: `sweep` is
owner only and already existed, so the vault is the book and the owner is the desk, which is also how a real
trading desk is arranged. `docs/DECISIONS.md` records why putting it in the settlement path would be wrong
twice over.

Two honest details about what a rebalance costs, because they are the interesting part rather than a footnote.

The only market for these two tokens is the pool this project created, and the only liquidity provider in it is
the vault. So the rebalance trades against the maker's own position: the 0.3% fee comes back and the price
impact lands on the book it came from. What that means is that in a closed system a maker cannot trade its
inventory home at all, it can only move the imbalance from its float into the price of its own pool. In a real
market the surplus is sold to somebody else and the same price impact is a cost paid outward. It is the same
operation either way, and this is why the spread has to cover it.

And the price does move, for the first time in this project's life. A decrease and an increase are both pro
rata, so fourteen fills left the pool at exactly `sqrtPriceX96 = 2^96`, tick 0, parity, which is the state
`yarn setup` created it in. The rebalance is the first operation here that moves it, and it has to be: the
inventory imbalance is real, and in a closed system the price is where a real imbalance shows up. After the run
above the pool sits at tick -2126, 0.8085 bALPHA per bBRAVO.

That has one consequence the maker has to be told about, and `yarn rebalance` prints it. A unit of full range
liquidity is worth `sqrt(price)` of token1 and `1/sqrt(price)` of token0, so `unitsPerLiquidityE18`, the maker's
conversion factor compiled into the `0x92` arguments, is exactly 1 only while the pool sits at parity. After
the rebalance it measured 0.899173157285162373 bALPHA per unit. Until the book was re-shipped with that figure,
the instruction was clamping `balanceOut` against 11.21% more bALPHA than the position could release, and
`reachableFromPosition()` reported the same overstatement because it reads the same number. The measured effect
on a fill was smaller than the drift, because `yarn fill` sizes the unwind as `amountOut / liquidity` and both
terms carry the same factor: the safety margin between what a 1% unwind releases and what the fill owes fell
from 16.6% to 4.8%, and the fill still sized and settled throughout.

The fix is one command on each side and neither is on the fill path: re-ship the book with the measured factor,
and `setRiskParams` the same number on the vault. Both have been applied. The live strategy carries
`unitsPerLiquidityE18` of `899173157285162368` and `cast call <vault> "unitsPerLiquidityE18()(uint256)"` returns
the same, which is why `reachableFromPosition()` and `reachableAmounts()` now agree to twelve significant
figures. The drift will reopen the next time the pool moves, and the point is that it is measurable rather than
that it is zero.

## Where the fill runs

In the tab, signed by the connected wallet. There is no backend, and the shape of the thing is the argument.

`solver/src/fillPlan.ts` is the fill: quote through a staticcall, size the unwind from the `amountOut` that
came back and round the percentage up, `POST /lp/decrease` and `POST /lp/increase`, encode the taker traits.
It touches the chain and the API through two injected interfaces and therefore does not know where it is
running. `yarn fill` gives it a viem HTTP transport and a private key, the dashboard gives it the same
transport and the wallet client wagmi built over the connected connector, and neither owns a second copy of
the arithmetic. The two proxies carry the Uniswap key and JSON-RPC and run none of this project's logic, as
Vite middleware locally and as the two serverless functions in `api/` in production. See Deployment above.

What used to force a process was one detail. `TakerTraitsLib.build` is `internal pure` Solidity, so it can
only run inside a contract, and `forge` is not available in a browser. `solver/src/takerTraits.ts` ports it:
a 22 byte header of ten `uint16` slice indexes packed into a `uint160` plus a `uint16` flag word, then the
slices concatenated in the order the `TakerDataSlices` enum declares. Every index is the end offset of its
slice, so each one is a running sum of the lengths before it, and the two conditional slices are the trap: a
recipient equal to the taker encodes nothing at all, and a zero deadline encodes nothing rather than five zero
bytes.

The port is proved rather than asserted, because its failure mode is silent. A slice index one byte off does
not fail to decode, it decodes a different slice, and the revert that reaches the taker is
`TakerTraitsAmountOutMustBeGreaterThanZero`, which names the amount and not the header.
`contracts/test/TakerTraits.t.sol` reads the fixtures `yarn fixtures` writes, calls the sponsor's own library
on the same arguments and asserts byte equality across twelve shapes: empty slices, one hook, both hooks, a
threshold, both conditional slices, every flag combination the project uses and its opposite. It then round
trips the live fill shape back through the library's own slice readers, which is what proves the unwind comes
out of `preTransferOut` and the redeposit out of `postTransferIn` rather than the other way round.

`contracts/script/Fill.s.sol` stays as the Solidity reference that diff is taken against, and it repeats the
assertion on inputs nobody chose. Every `yarn fill` writes its request to `deployments/fill.local.json`
including the traits it built, and replaying that file through the script compares them against
`TakerTraitsLib.build` on the real v4 Actions payloads of that fill before it simulates the swap. Fixtures
prove the arithmetic on shapes we picked; that check proves it on shapes the Uniswap API picked.

## The solver, and why it being off chain is not the question

A solver is off-chain by nature in any RFQ system. 1inch's own Fusion works that way: the maker signs an
intent, resolvers compete off chain, and the chain sees only the settlement. Aqua is the same shape, since a
strategy is a number in a mapping and somebody outside has to decide when to pull against it.

So the question is never whether a solver runs off chain, it is whether the maker has to trust it. This maker
does not. The order is immutable, the vault's parameters are immutable, and the one thing the taker supplies
per fill, the withdrawal calldata, is judged on chain by the five guards above rather than believed. An
adversarial taker chooses how the position is unwound and never whether the maker ends up short, never where
the released collateral lands, and never more than `maxUnwindPct` of it in one fill.

That is why the taker being a browser tab changes nothing about the security model, and why deleting the
backend cost nothing: there was no trust placed in it to remove. It also makes the demo self serve, which is
worth more than it sounds. `TestERC20.mint` is public, the dashboard has a button for it and a button for the
router approval, and a judge can fill against this maker from their own wallet.

## URC-3

The vault implements `IHookStats` from URC-3, published by Uniswap Labs on 2026-06-11. The standard's
normative invariant is that `getEffectiveLiquidity` should not exceed `getReserves`, and instruction `0x92` is
that invariant enforced inside a virtual machine one instruction before settlement rather than merely reported.

URC-3's motivating cases name, verbatim, deploying liquidity in external protocols, rehypothecating assets and
maintaining reserves outside the PoolManager. This vault does all three.

Both accessors report real per token amounts: the position's content at the live pool price, plus the vault's
free float on whichever side it sits on. They used to credit one scalar to both tokens, which is exact at
parity and wrong everywhere else, in a direction that depends on which way the pool has moved. They also
validate that the `PoolKey` handed to them is the pool backing the position and revert otherwise, which the
standard's conformance list requires and which the float lookups alone would otherwise have papered over.

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

Tick math is reproduced on chain, and it used not to be. The note that stood here said the conversion from
liquidity to output units was a conservative maker parameter enforced after the fact by the hook's delta
check, and that reimplementing v4 pricing would be work for a number the guards already verified. That was
wrong in a way worth recording: the guards did not verify it. They verified that enough of one token arrived,
not that everything the position released did, and closing that needed exactly the tick math the note declined
to write. `LiquidityAmounts.sol` is the smallest version of it, two routines and their three cases.

What is still a maker parameter is `unitsPerLiquidityE18`, which instruction `0x92` uses to price the clamp in
a `view` without reading the pool. It drifts as the pool moves off parity, `yarn rebalance` prints the drift,
and the fix is to re-ship with the measured factor. The guards and the URC-3 report no longer depend on it.
