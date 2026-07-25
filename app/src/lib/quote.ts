import { concatHex, numberToHex, type Address, type Hex } from 'viem'

import { routerAbi } from './abi'
import { publicClient } from './client'
import { orderRecord, type DeploymentRecord } from './config'
import { ok, unavailable, type Result } from './format'

/**
 * Taker traits, built the way `TakerTraitsLib.build` builds them.
 *
 * The header is 22 bytes: a `uint160` of ten 16 bit slice indexes, then a `uint16` of flags. A quote needs no
 * threshold, no recipient, no deadline, no hook data and no instruction arguments, so every index is zero and
 * the header collapses to twenty zero bytes followed by the flags. A real fill fills those slices with the
 * `/lp/decrease` and `/lp/increase` calldata, which is the solver's job.
 */
export const IS_EXACT_IN_BIT_FLAG = 0x0001
export const IS_A_TO_B_BIT_FLAG = 0x0080

export function buildQuoteTakerTraits(options: { isExactIn: boolean; isAToB: boolean }): Hex {
  const flags = (options.isExactIn ? IS_EXACT_IN_BIT_FLAG : 0) | (options.isAToB ? IS_A_TO_B_BIT_FLAG : 0)
  return concatHex([numberToHex(0n, { size: 20 }), numberToHex(flags, { size: 2 })])
}

export interface Order {
  maker: Address
  traits: bigint
  data: Hex
}

/** The order the book quotes on. It is published by the setup script, not reconstructed here. */
export function orderFrom(deployment: DeploymentRecord): Result<Order> {
  const order = orderRecord(deployment)
  if (!order) {
    return unavailable(
      'no order in deployments/sepolia.json yet. The setup script writes it when it ships the strategy, and quote() cannot be called without the exact bytes.',
    )
  }
  try {
    return ok({ maker: order.maker, traits: BigInt(order.traits), data: order.data })
  } catch (error) {
    return unavailable(`the order in deployments/sepolia.json is malformed: ${(error as Error).message}`)
  }
}

export interface QuoteResult {
  amountIn: bigint
  amountOut: bigint
  orderHash: Hex
  takerTraitsAndData: Hex
  amount: bigint
  isExactIn: boolean
  isAToB: boolean
}

/**
 * `quote()` through a staticcall, which is what `asView()` exists for. Instruction 0x92 runs inside this call
 * and clamps the quotable balance, so the number that comes back is already the honest one.
 */
export async function requestQuote(params: {
  router: Address
  order: Order
  amount: bigint
  isExactIn: boolean
  isAToB: boolean
  takerTraitsAndData?: Hex
}): Promise<QuoteResult> {
  const takerTraitsAndData =
    params.takerTraitsAndData ??
    buildQuoteTakerTraits({ isExactIn: params.isExactIn, isAToB: params.isAToB })

  const [amountIn, amountOut, orderHash] = await publicClient.readContract({
    address: params.router,
    abi: routerAbi,
    functionName: 'quote',
    args: [params.order, params.amount, takerTraitsAndData],
  })

  return {
    amountIn,
    amountOut,
    orderHash,
    takerTraitsAndData,
    amount: params.amount,
    isExactIn: params.isExactIn,
    isAToB: params.isAToB,
  }
}
