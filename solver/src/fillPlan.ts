/**
 * Everything a fill needs to decide, in one place, with no opinion about where it runs.
 *
 * This module is the fill. It quotes the book, sizes the withdrawal from that quote, asks the Uniswap API for
 * the two payloads and encodes the taker traits, and it returns a plan that the caller signs and broadcasts.
 * `solver/src/fill.ts` runs it from a terminal with a private key, `app/src/lib/fill.ts` runs it in a browser
 * tab with the connected wallet, and neither owns a second copy of the sizing arithmetic.
 *
 * It reaches the chain and the API only through the two interfaces below, which is what lets the same code run
 * in both places: the terminal reads through a viem HTTP transport and calls the API with an `x-api-key`
 * header, the tab reads through the same transport and calls the API through the dev server proxy, and the
 * plan cannot tell the difference.
 *
 * The ordering below is the design, not a convenience.
 *
 *   1. Quote through `quote()` on a staticcall, which is what `asView()` exists to express. Instruction `0x92`
 *      runs inside that call and clamps the quotable balance to what the position can genuinely release, so
 *      the number that comes back is already the truthful one.
 *   2. Size the unwind from the `amountOut` that quote returned, not from the input amount and not from a
 *      guess. `liquidityPercentageToDecrease` is an integer in [1, 100], so the percentage is rounded UP and
 *      the surplus stays in the vault as float. A just in time withdrawal can never be exact, and pretending
 *      otherwise would put the fill one wei short of the hook's floor check.
 *   3. `POST /lp/decrease` for that percentage and `POST /lp/increase` for the redeposit. Both are built by
 *      the API against live chain state, which is why they cannot be baked into the immutable order and have
 *      to travel with the taker.
 *   4. Encode the taker traits, with the two payloads in the slices the hooks read them from.
 *
 * Two failure modes are worth recognising on sight. An Aqua shortfall surfaces as `ERC20InsufficientBalance`
 * from the token rather than as an Aqua error, because `Aqua.pull` decrements the virtual balance first and
 * calls `safeTransferFrom` afterwards. A misaligned taker traits header surfaces as
 * `TakerTraitsAmountOutMustBeGreaterThanZero`, because a wrong slice index decodes a different slice rather
 * than failing to decode, which is what `contracts/test/TakerTraits.t.sol` exists to rule out.
 */
import type { Address, Hex } from 'viem'

import { buildFillTakerTraits, buildQuoteTakerTraits } from './takerTraits.js'

/** The order the book quotes on, exactly as it was shipped. One byte of difference is a different strategy. */
export interface FillOrder {
  maker: Address
  traits: bigint
  data: Hex
}

export interface QuoteRead {
  amountIn: bigint
  amountOut: bigint
  orderHash: Hex
}

/** A `/lp/decrease` response, reduced to what a fill uses. */
export interface DecreaseBuild {
  to: Address
  data: Hex
  /** What the API says the withdrawal releases, per token, in the pool's sorted order. */
  amount0: bigint
  amount1: bigint
}

/** A `/lp/increase` response, reduced the same way. The redeposit names one side and the API computes the other. */
export interface IncreaseBuild {
  to: Address
  data: Hex
}

/** Chain reads. Four calls, all `view`, all answerable by any Sepolia endpoint. */
export interface ChainReader {
  quote(params: { order: FillOrder; amount: bigint; takerTraitsAndData: Hex }): Promise<QuoteRead>
  positionLiquidity(tokenId: bigint): Promise<bigint>
  balanceOf(token: Address, owner: Address): Promise<bigint>
  reachableFromPosition(vault: Address): Promise<bigint>
}

/** The two Uniswap calls a fill is funded by. Both are executed on chain, inside the fill, by the vault. */
export interface LiquidityApi {
  decrease(params: {
    walletAddress: Address
    tokenId: bigint
    token0: Address
    token1: Address
    percent: number
  }): Promise<DecreaseBuild>
  increase(params: {
    walletAddress: Address
    tokenId: bigint
    token0: Address
    token1: Address
    independentToken: Address
    independentAmount: bigint
  }): Promise<IncreaseBuild>
}

export interface FillProgress {
  onStep?: (step: { index: number; label: string }) => void
  onInfo?: (label: string, value: string) => void
}

export interface PlanFillParams extends FillProgress {
  order: FillOrder
  /** The hash the strategy was shipped under. The quote's own hash is checked against it. */
  orderHash?: Hex
  /** Whoever signs the swap. The connected wallet in the browser, the CLI key in a terminal. */
  taker: Address
  vault: Address
  positionManager: Address
  tokenId: bigint
  /** Sorted, as the order data and the pool store them. */
  token0: Address
  token1: Address
  /** True means token0 in and token1 out, which is the direction the strategy was shipped for. */
  isAToB: boolean
  /** Taker amount in the smallest unit. Exact in, so this is what the taker pays. */
  amount: bigint
  /** The maker's own conversion factor, the one instruction `0x92` and the vault's guards read. */
  unitsPerLiquidityE18: bigint
  /** Largest share of the position the maker authorised one fill to unwind. */
  maxUnwindPct: number
}

export interface FillPlan {
  taker: Address
  tokenIn: Address
  tokenOut: Address
  isAToB: boolean
  amount: bigint
  order: FillOrder
  orderHash: Hex
  quotedIn: bigint
  quotedOut: bigint
  amountOutMin: bigint
  /** Position liquidity before the fill, and what it is worth at the maker's conversion factor. */
  liquidity: bigint
  deployed: bigint
  reachable: bigint
  floatIn: bigint
  floatOut: bigint
  /** The exact share the payout needs, and the integer the API was actually asked for. */
  exactPct: number
  unwindPercent: number
  releasedIn: bigint
  releasedOut: bigint
  surplus: bigint
  redeposit: bigint
  positionManager: Address
  decreaseCalldata: Hex
  increaseCalldata: Hex
  /** The 22 byte header and the four slices, ready for `swap()`. */
  takerTraitsAndData: Hex
}

/**
 * Margin added on top of the exact percentage before rounding up.
 *
 * The instruction values a unit of position liquidity with the maker's conservative conversion factor and does
 * not reproduce v4 tick math, so the amount a withdrawal actually releases can differ slightly from the linear
 * estimate. The vault's first guard is a floor on the realised delta, `outAfter >= outBefore + amountOut`, and
 * it is checked after the payload has run, so being one percent short there costs a reverted fill. Five
 * percent here is the same margin as the maker's haircut and it cannot push the request past the cap: the
 * instruction has already clamped `amountOut` to 23.75% of the position, and 23.75 x 1.05 rounds to 25, which
 * is exactly `maxUnwindPct`.
 */
export const UNWIND_SAFETY = 0.05

/**
 * Share of the free float the redeposit puts back to work.
 *
 * The remainder absorbs the difference between what the API quotes for the redeposit and what the position
 * manager actually settles at the current price. A redeposit that asks for more than the vault holds reverts
 * the whole fill inside Permit2, so this errs downward on purpose and leaves a little dust behind.
 */
export const REDEPOSIT_SHARE = 98n

/** Slippage floor on the fill itself, in basis points below the quote. */
export const FILL_SLIPPAGE_BPS = 50n

/**
 * Quote, size, fetch and encode. Reads only, so this is safe to run before anyone commits to signing.
 *
 * Every throw below names what is wrong and what to do about it, because each one of them is a fill that would
 * otherwise revert inside the VM with a message about the wrong thing.
 */
export async function planFill(
  chain: ChainReader,
  api: LiquidityApi,
  params: PlanFillParams,
): Promise<FillPlan> {
  const step = (index: number, label: string) => params.onStep?.({ index, label })
  const info = (label: string, value: string) => params.onInfo?.(label, value)

  const [tokenIn, tokenOut] = params.isAToB
    ? [params.token0, params.token1]
    : [params.token1, params.token0]

  // -------------------------------------------------------------------
  step(1, 'quote() through a staticcall, which is what asView() is for')
  // -------------------------------------------------------------------

  const takerTraitsForQuote = buildQuoteTakerTraits({ isExactIn: true, isAToB: params.isAToB })
  const quoted = await chain.quote({
    order: params.order,
    amount: params.amount,
    takerTraitsAndData: takerTraitsForQuote,
  })

  if (params.orderHash && quoted.orderHash.toLowerCase() !== params.orderHash.toLowerCase()) {
    throw new Error(
      `router.quote reports order hash ${quoted.orderHash}, the shipped one is ${params.orderHash}. The order ` +
        'and the strategy have diverged, so run yarn demo:reset to ship one that matches.',
    )
  }
  if (quoted.amountOut === 0n) throw new Error('the book quoted nothing, there is no fill to make')

  const amountOutMin = (quoted.amountOut * (10_000n - FILL_SLIPPAGE_BPS)) / 10_000n
  info('amountIn', quoted.amountIn.toString())
  info('amountOut', quoted.amountOut.toString())
  info('amountOutMin', `${amountOutMin}, ${FILL_SLIPPAGE_BPS} bps below the quote`)

  // -------------------------------------------------------------------
  step(2, 'size the unwind from amountOut, and round the percentage up')
  // -------------------------------------------------------------------

  const [liquidity, floatIn, floatOut, reachable] = await Promise.all([
    chain.positionLiquidity(params.tokenId),
    chain.balanceOf(tokenIn, params.vault),
    chain.balanceOf(tokenOut, params.vault),
    chain.reachableFromPosition(params.vault),
  ])
  if (liquidity === 0n) {
    throw new Error(`position ${params.tokenId} carries no liquidity, there is nothing to unwind`)
  }

  const deployed = (liquidity * params.unitsPerLiquidityE18) / 10n ** 18n

  // The vault's first guard is a delta check, `outAfter >= outBefore + amountOut`, so the float already in the
  // vault does not count towards it. The withdrawal alone has to release the whole payout.
  const exactPct = (Number((quoted.amountOut * 10n ** 12n) / deployed) / 1e12) * 100
  const unwindPercent = Math.max(1, Math.min(100, Math.ceil(exactPct * (1 + UNWIND_SAFETY))))

  info('exact unwind', `${exactPct.toFixed(6)}% of the position`)
  info('requested', `${unwindPercent}%, rounded up because liquidityPercentageToDecrease is an integer`)

  if (unwindPercent > params.maxUnwindPct) {
    throw new Error(
      `sizing wants ${unwindPercent}% of the position and the maker authorised ${params.maxUnwindPct}%. ` +
        'Instruction 0x92 should have clamped the quote below that, so this means the order and the vault ' +
        'disagree on the risk parameters.',
    )
  }

  // -------------------------------------------------------------------
  step(3, 'POST /lp/decrease for the unwind, POST /lp/increase for the redeposit')
  // -------------------------------------------------------------------

  const decrease = await api.decrease({
    walletAddress: params.vault,
    tokenId: params.tokenId,
    token0: params.token0,
    token1: params.token1,
    percent: unwindPercent,
  })
  const [releasedIn, releasedOut] = params.isAToB
    ? [decrease.amount0, decrease.amount1]
    : [decrease.amount1, decrease.amount0]

  if (releasedOut < quoted.amountOut) {
    throw new Error(
      `${unwindPercent}% of the position releases ${releasedOut} and the fill owes ${quoted.amountOut}. The ` +
        "vault's floor check would revert, so the sizing is wrong.",
    )
  }
  const surplus = releasedOut - quoted.amountOut
  info('/lp/decrease', `${unwindPercent}% releases ${releasedIn} in and ${releasedOut} out, surplus ${surplus}`)

  // What the vault will hold when `postTransferIn` runs. The pull has already paid the taker by then, and the
  // push has already credited the vault with the taker's input, which is exactly why the redeposit can be two
  // sided at all.
  const availableOut = floatOut + releasedOut - quoted.amountOut
  const availableIn = floatIn + releasedIn + quoted.amountIn
  const redeposit = ((availableOut < availableIn ? availableOut : availableIn) * REDEPOSIT_SHARE) / 100n
  if (redeposit === 0n) throw new Error('nothing left to redeposit after the fill, the sizing is wrong')

  const increase = await api.increase({
    walletAddress: params.vault,
    tokenId: params.tokenId,
    token0: params.token0,
    token1: params.token1,
    independentToken: tokenOut,
    independentAmount: redeposit,
  })
  info('/lp/increase', `${redeposit} named on the output side, the API computes the other leg`)

  const pinned = params.positionManager.toLowerCase()
  if (decrease.to.toLowerCase() !== pinned || increase.to.toLowerCase() !== pinned) {
    throw new Error(
      `the API built calldata for ${decrease.to} and ${increase.to}, and the vault pins ` +
        `${params.positionManager}. It would reject both payloads.`,
    )
  }

  // -------------------------------------------------------------------
  step(4, 'encode the taker traits, unwind in preTransferOut, redeposit in postTransferIn')
  // -------------------------------------------------------------------

  const takerTraitsAndData = buildFillTakerTraits({
    taker: params.taker,
    amountOutMin,
    decreaseCalldata: decrease.data,
    increaseCalldata: increase.data,
    isAToB: params.isAToB,
  })
  info('taker traits', `${(takerTraitsAndData.length - 2) / 2} bytes, 22 of header and four slices`)

  return {
    taker: params.taker,
    tokenIn,
    tokenOut,
    isAToB: params.isAToB,
    amount: params.amount,
    order: params.order,
    orderHash: quoted.orderHash,
    quotedIn: quoted.amountIn,
    quotedOut: quoted.amountOut,
    amountOutMin,
    liquidity,
    deployed,
    reachable,
    floatIn,
    floatOut,
    exactPct,
    unwindPercent,
    releasedIn,
    releasedOut,
    surplus,
    redeposit,
    positionManager: params.positionManager,
    decreaseCalldata: decrease.data,
    increaseCalldata: increase.data,
    takerTraitsAndData,
  }
}
