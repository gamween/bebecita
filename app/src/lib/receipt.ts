import { parseEventLogs, type Address, type Hex, type Log } from 'viem'

import { poolManagerEventsAbi, routerEventsAbi, vaultEventsAbi } from './abi'
import { publicClient } from './client'
import { ok, unavailable, type Result } from './format'

/**
 * A fill, read back out of its receipt.
 *
 * The fill runs in this tab and knows what it asked for, but a dashboard that reprinted its own request would
 * only be proving that it can print. So the transaction hash is the only thing taken on trust: everything
 * shown about a fill is decoded here, from logs fetched from the chain.
 *
 * Four events tell the whole story of one fill, and they come from four different contracts:
 *
 *   Swapped         the router      what the taker paid and was paid
 *   Unwound         the vault       what `preTransferOut` released against what the VM said was owed
 *   Redeposited     the vault       the position's liquidity before and after `postTransferIn`
 *   ModifyLiquidity the PoolManager twice, both sent by the PositionManager, which is the claim itself
 */

export interface SwappedEvent {
  orderHash: Hex
  maker: Address
  taker: Address
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  amountOut: bigint
}

export interface PositionCall {
  /** `decrease` for the unwind that funds the payout, `increase` for the redeposit. */
  kind: 'decrease' | 'increase'
  liquidityDelta: bigint
  sender: Address
  tickLower: number
  tickUpper: number
}

export interface FillReceipt {
  hash: Hex
  status: 'success' | 'reverted'
  blockNumber: bigint
  gasUsed: bigint
  swapped: Result<SwappedEvent>
  unwound: Result<{ token: Address; released: bigint; required: bigint }>
  redeposited: Result<{ liquidityBefore: bigint; liquidityAfter: bigint }>
  positionCalls: PositionCall[]
  /** Position liquidity across the fill, when both the redeposit event and the two deltas are present. */
  liquidity: Result<{ beforeUnwind: bigint; afterUnwind: bigint; afterRedeposit: bigint }>
}

export interface FillAddresses {
  router: Address
  vault: Address
  poolManager: Address | null
  positionManager: Address | null
  poolId?: Hex | null
}

const at = (address: Address | null, logs: Log[]): Log[] =>
  address ? logs.filter((log) => log.address.toLowerCase() === address.toLowerCase()) : []

/** Reads a fill transaction and decodes the four events that make the claim checkable. */
export async function readFillReceipt(hash: Hex, addresses: FillAddresses): Promise<FillReceipt> {
  const receipt = await publicClient.getTransactionReceipt({ hash })
  const logs = receipt.logs as Log[]

  const swappedLogs = parseEventLogs({ abi: routerEventsAbi, eventName: 'Swapped', logs: at(addresses.router, logs) })
  const vaultLogs = at(addresses.vault, logs)
  const unwoundLogs = parseEventLogs({ abi: vaultEventsAbi, eventName: 'Unwound', logs: vaultLogs })
  const redepositedLogs = parseEventLogs({ abi: vaultEventsAbi, eventName: 'Redeposited', logs: vaultLogs })
  const modifyLogs = parseEventLogs({
    abi: poolManagerEventsAbi,
    eventName: 'ModifyLiquidity',
    logs: at(addresses.poolManager, logs),
  })

  const swapped = swappedLogs.at(0)
  const unwound = unwoundLogs.at(0)
  const redeposited = redepositedLogs.at(0)

  const positionCalls: PositionCall[] = modifyLogs
    .filter((log) => (addresses.poolId ? log.args.id.toLowerCase() === addresses.poolId.toLowerCase() : true))
    .map((log) => ({
      kind: log.args.liquidityDelta < 0n ? ('decrease' as const) : ('increase' as const),
      liquidityDelta: log.args.liquidityDelta,
      sender: log.args.sender,
      tickLower: log.args.tickLower,
      tickUpper: log.args.tickUpper,
    }))

  const decrease = positionCalls.find((call) => call.kind === 'decrease')
  const liquidity: Result<{ beforeUnwind: bigint; afterUnwind: bigint; afterRedeposit: bigint }> =
    redeposited && decrease
      ? ok({
          // Redeposited reports the liquidity the redeposit started from, which is the position after the
          // unwind. The decrease's own delta is what it was before it.
          beforeUnwind: redeposited.args.liquidityBefore - decrease.liquidityDelta,
          afterUnwind: redeposited.args.liquidityBefore,
          afterRedeposit: redeposited.args.liquidityAfter,
        })
      : unavailable(
          redeposited
            ? 'the PoolManager ModifyLiquidity events were not in this receipt, so the liquidity before the unwind cannot be derived'
            : 'no Redeposited event from the vault in this receipt',
        )

  return {
    hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    swapped: swapped
      ? ok({
          orderHash: swapped.args.orderHash,
          maker: swapped.args.maker,
          taker: swapped.args.taker,
          tokenIn: swapped.args.tokenIn,
          tokenOut: swapped.args.tokenOut,
          amountIn: swapped.args.amountIn,
          amountOut: swapped.args.amountOut,
        })
      : unavailable('no Swapped event from the router in this receipt'),
    unwound: unwound
      ? ok({ token: unwound.args.token, released: unwound.args.released, required: unwound.args.required })
      : unavailable('no Unwound event from the vault, the preTransferOut hook did not run'),
    redeposited: redeposited
      ? ok({ liquidityBefore: redeposited.args.liquidityBefore, liquidityAfter: redeposited.args.liquidityAfter })
      : unavailable('no Redeposited event from the vault, the postTransferIn hook did not run'),
    positionCalls,
    liquidity,
  }
}
