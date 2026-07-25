import type { Address, Hex } from 'viem'

import { routerEventsAbi, vaultEventsAbi } from './abi'
import { publicClient } from './client'
import { reason } from './format'

/**
 * What the vault has done, read from its own logs.
 *
 * Two questions need history rather than state. Which strategies has this maker shipped, not just the live
 * one, because `yarn demo:reset` overwrites the record every time it re-salts. And how much has actually been
 * settled through them, which is the headline number this whole project exists to make large.
 *
 * Both come out of one `eth_getLogs` per block window: the vault's `Shipped`, whose `strategyHash` is indexed,
 * and SwapVM's `Swapped`, which has no indexed parameter at all and is filtered by the router's address.
 *
 * The window is chunked because the public Sepolia endpoints cap a range: 10 000 blocks on drpc's free tier,
 * 50 000 on publicnode, which also refuses historical logs outright. The scan therefore starts at the head and
 * walks backwards, keeps whatever it managed to read, and reports the block it actually reached rather than
 * pretending the answer is complete.
 */

/** Under the smallest cap any of the fallback endpoints enforces. */
const CHUNK = 9_000n
/** About six days of Sepolia at twelve seconds a block, which is longer than this project has existed. */
const DEFAULT_WINDOW = 45_000n

export interface ShippedStrategy {
  hash: Hex
  app: Address
  blockNumber: bigint
  txHash: Hex
}

export interface SettledFill {
  orderHash: Hex
  maker: Address
  taker: Address
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  amountOut: bigint
  blockNumber: bigint
  txHash: Hex
}

export interface History {
  at: number
  head: bigint
  /** The oldest block the scan actually reached. Everything before it is unread, not empty. */
  scannedFrom: bigint
  chunks: number
  strategies: ShippedStrategy[]
  fills: SettledFill[]
  /** Set when a chunk failed. The results above are still whatever was read before that. */
  error: string | null
}

const lower = (value: string) => value.toLowerCase()

/**
 * Reads the vault's `Shipped` and the router's `Swapped` over a bounded window ending at the head.
 *
 * Newest chunk first, so a demo machine on a rate limited endpoint still shows the fills that just happened.
 */
export async function readHistory(params: {
  vault: Address
  router: Address
  maker?: Address
  window?: bigint
}): Promise<History> {
  const head = await publicClient.getBlockNumber()
  const window = params.window ?? DEFAULT_WINDOW
  const floor = head > window ? head - window : 0n

  const strategies: ShippedStrategy[] = []
  const fills: SettledFill[] = []
  const maker = lower(params.maker ?? params.vault)
  const vault = lower(params.vault)
  const router = lower(params.router)

  let scannedFrom = head + 1n
  let chunks = 0
  let error: string | null = null

  while (scannedFrom > floor) {
    const toBlock = scannedFrom - 1n
    const fromBlock = toBlock > floor + CHUNK ? toBlock - CHUNK : floor
    try {
      const logs = await publicClient.getLogs({
        address: [params.vault, params.router],
        events: [...vaultEventsAbi, ...routerEventsAbi],
        fromBlock,
        toBlock,
      })
      chunks += 1
      for (const log of logs) {
        const address = lower(log.address)
        if (log.eventName === 'Shipped' && address === vault) {
          strategies.push({
            hash: log.args.strategyHash as Hex,
            app: log.args.app as Address,
            blockNumber: log.blockNumber ?? 0n,
            txHash: log.transactionHash ?? ('0x' as Hex),
          })
        }
        if (log.eventName === 'Swapped' && address === router && lower(log.args.maker as string) === maker) {
          fills.push({
            orderHash: log.args.orderHash as Hex,
            maker: log.args.maker as Address,
            taker: log.args.taker as Address,
            tokenIn: log.args.tokenIn as Address,
            tokenOut: log.args.tokenOut as Address,
            amountIn: log.args.amountIn as bigint,
            amountOut: log.args.amountOut as bigint,
            blockNumber: log.blockNumber ?? 0n,
            txHash: log.transactionHash ?? ('0x' as Hex),
          })
        }
      }
    } catch (cause) {
      // A capped or non archival endpoint fails here. Whatever was read stays, and the caller says how far the
      // scan got instead of claiming the vault has no history.
      error = reason(cause)
      break
    }
    scannedFrom = fromBlock
  }

  const byBlock = <T extends { blockNumber: bigint }>(left: T, right: T) => (left.blockNumber < right.blockNumber ? -1 : 1)

  return {
    at: Date.now(),
    head,
    scannedFrom,
    chunks,
    strategies: strategies.sort(byBlock),
    fills: fills.sort(byBlock),
    error,
  }
}

/** Settled volume, both sides, summed over the fills the scan found. */
export function settled(fills: SettledFill[]): { amountIn: bigint; amountOut: bigint; count: number } {
  return fills.reduce(
    (total, fill) => ({
      amountIn: total.amountIn + fill.amountIn,
      amountOut: total.amountOut + fill.amountOut,
      count: total.count + 1,
    }),
    { amountIn: 0n, amountOut: 0n, count: 0 },
  )
}
