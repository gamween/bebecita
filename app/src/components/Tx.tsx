import { integer } from '../lib/format'
import { txHash, type TxState } from '../lib/tx'
import { TxLink } from './primitives'

/**
 * One transaction, in whichever of its four states it is in.
 *
 * The hash is a link from the moment it exists, which includes the failed state: a transaction that reverted
 * on chain has a receipt, and that receipt is the thing worth reading. A rejection in the wallet has no hash,
 * and says so instead of showing an empty link.
 */

const WORDING: Record<TxState['status'], string> = {
  idle: '',
  signing: 'waiting on the wallet',
  pending: 'sent, waiting for a block',
  confirmed: 'confirmed',
  failed: 'failed',
}

export function TxStatus({ state, label }: { state: TxState; label?: string }) {
  if (state.status === 'idle') return null
  const hash = txHash(state)
  return (
    <div className={`tx tx-${state.status}`}>
      <span className="tx-dot" />
      <span className="tx-what">
        {label ? <span className="tx-label">{label}</span> : null}
        <span className="tx-state">{WORDING[state.status]}</span>
      </span>
      <span className="tx-detail">
        {state.status === 'confirmed' ? (
          <span className="faint">
            block {integer(state.blockNumber)}, gas {integer(state.gasUsed)}
          </span>
        ) : null}
        {state.status === 'failed' ? <span className="tx-error">{state.message}</span> : null}
        {hash ? <TxLink hash={hash} /> : null}
      </span>
    </div>
  )
}
