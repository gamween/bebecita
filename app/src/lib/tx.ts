import { useCallback, useMemo, useRef, useState } from 'react'
import type { Hex, TransactionReceipt } from 'viem'

import { publicClient } from './client'
import { describeError } from './errors'

/**
 * The life of one transaction, as the page tells it.
 *
 * Four states and no spinner that means all of them. `signing` is the wallet asking, and it is the only state
 * where nothing exists yet. From `pending` onwards a hash exists, so the hash is a link from that moment on
 * and stays one through both terminal states, including the failed one: a reverted transaction is on chain
 * and its receipt is the most useful thing on the screen.
 */
export type TxState =
  | { status: 'idle' }
  | { status: 'signing' }
  | { status: 'pending'; hash: Hex }
  | { status: 'confirmed'; hash: Hex; blockNumber: bigint; gasUsed: bigint }
  | { status: 'failed'; hash: Hex | null; message: string }

export const txIdle: TxState = { status: 'idle' }

/** The hash, as soon as one exists, whatever the transaction went on to do. */
export function txHash(state: TxState): Hex | null {
  if (state.status === 'pending' || state.status === 'confirmed') return state.hash
  if (state.status === 'failed') return state.hash
  return null
}

export interface UseTx {
  state: TxState
  /**
   * Runs `send`, which is expected to hand the request to the wallet and return a hash, then waits for the
   * receipt. Returns the receipt on success and null on anything else, so a caller can chain without a catch.
   */
  send: (
    request: () => Promise<Hex>,
    options?: { onConfirmed?: (receipt: TransactionReceipt) => void },
  ) => Promise<TransactionReceipt | null>
  reset: () => void
  busy: boolean
}

export function useTx(): UseTx {
  const [state, setState] = useState<TxState>(txIdle)
  const running = useRef(false)

  const send = useCallback<UseTx['send']>(async (request, options) => {
    if (running.current) return null
    running.current = true
    setState({ status: 'signing' })
    let hash: Hex | null = null
    try {
      hash = await request()
      setState({ status: 'pending', hash })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        setState({
          status: 'failed',
          hash,
          message: 'the transaction reverted on chain, its receipt is on Etherscan',
        })
        return null
      }
      setState({ status: 'confirmed', hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed })
      options?.onConfirmed?.(receipt)
      return receipt
    } catch (error) {
      setState({ status: 'failed', hash, message: describeError(error) })
      return null
    } finally {
      running.current = false
    }
  }, [])

  const reset = useCallback(() => setState(txIdle), [])

  // Memoised because callers hold this object in dependency arrays. A fresh object per render invalidated every
  // `useCallback` that took one, on every render, which is a live trap for the first effect to depend on any of
  // them. `send` and `reset` are already stable, so this only changes identity when the state does.
  return useMemo(
    () => ({ state, send, reset, busy: state.status === 'signing' || state.status === 'pending' }),
    [reset, send, state],
  )
}
