import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseUnits, type Address, type Hex } from 'viem'

import { NetworkPanel } from '../components/NetworkPanel'
import { Addr, Metric, Show, Unit } from '../components/primitives'
import type { Wallet } from '../App'
import { vaultAbi } from '../lib/abi'
import { CHAIN, publicClient, walletClientFor } from '../lib/client'
import type { AppConfig } from '../lib/config'
import {
  fillWiring,
  probeSolver,
  runFill,
  solverUrl,
  type FillResult,
  type FillStep,
  type SolverProbe,
} from '../lib/fill'
import {
  addressUrl,
  ago,
  amount as fmtAmount,
  integer,
  ok,
  reason,
  short,
  stringify,
  txUrl,
  type Result,
} from '../lib/format'
import { readHistory, settled, type History } from '../lib/history'
import { orderFrom, requestQuote, type QuoteResult } from '../lib/quote'
import { readFillReceipt, type FillReceipt } from '../lib/receipt'
import { ratio, slacOf, tokens as wholeTokens, type SlacLeg, type SlacNumerator } from '../lib/slac'
import { readSnapshot, tokenOf, type Snapshot } from '../lib/state'
import { claimFees, decrease, findTransactionRequest, poolInfo, type TransactionRequest } from '../lib/uniswap'

type Action<T> =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string }

const idle = { status: 'idle' } as const
const notRead: Result<never> = { ok: false, reason: 'not read yet' }

/** Chain state. Five seconds is the polite end of live, and the Uniswap API is not touched by it. */
const STATE_POLL_MS = 5_000
/** Logs only move when a fill or a ship lands, so they are read on a slower loop. */
const HISTORY_POLL_MS = 60_000
/** Local and cheap, but there is no reason to ask more often than a person can press a button. */
const SOLVER_POLL_MS = 20_000
/** The Uniswap key allows six requests a second. One pool_info per manual refresh, never on a render. */
const POOL_INFO_MIN_GAP_MS = 15_000

/** Grouped digits without the locale's comma, which reads badly next to hex. */
const grouped = (value: number) => Math.round(value).toLocaleString('en-US').replace(/,/g, ' ')

/** Position liquidity is a 1e18 scaled quantity, so it reads as a number rather than as a 24 digit integer. */
const liquidityText = (value: bigint) => fmtAmount(value < 0n ? -value : value, 18, 2)

function ResultCard({
  title,
  state,
  children,
}: {
  title: string
  state: Action<unknown>
  children?: React.ReactNode
}) {
  if (state.status === 'idle') return null
  const className = state.status === 'ok' ? 'result ok' : state.status === 'error' ? 'result error' : 'result pending'
  return (
    <div className={className}>
      <h4>{title}</h4>
      {state.status === 'pending' ? <div className="muted">waiting on the network</div> : null}
      {state.status === 'error' ? <div className="mono" style={{ overflowWrap: 'anywhere' }}>{state.message}</div> : null}
      {state.status === 'ok' ? children : null}
    </div>
  )
}

function TxRequestView({ tx, expected }: { tx: TransactionRequest | null; expected: string | null }) {
  if (!tx) return <div className="muted">the response carried no transaction request</div>
  const pinned = expected && tx.to.toLowerCase() === expected.toLowerCase()
  return (
    <dl className="kv">
      <dt>to</dt>
      <dd>
        <Addr value={tx.to} length={10} />{' '}
        {expected ? (
          pinned ? (
            <span className="faint">matches the position manager the vault pins</span>
          ) : (
            <span className="unavailable">not the pinned position manager, the vault would reject this</span>
          )
        ) : null}
      </dd>
      <dt>selector</dt>
      <dd>{tx.data.slice(0, 10)}</dd>
      <dt>calldata</dt>
      <dd style={{ maxHeight: 120, overflow: 'auto' }}>{tx.data}</dd>
    </dl>
  )
}

/** One of the two figures this whole project reduces to. */
function Figure({
  label,
  note,
  children,
  sub,
}: {
  label: string
  note: string
  children: React.ReactNode
  sub?: React.ReactNode
}) {
  return (
    <div className="figure">
      <div className="figure-label">
        {label}
        <span className="note">{note}</span>
      </div>
      <div className="figure-value">{children}</div>
      {sub ? <div className="figure-sub">{sub}</div> : null}
    </div>
  )
}

function SlacCard({
  title,
  denominator,
  numerator,
  leg,
  strategies,
}: {
  title: string
  denominator: string
  numerator: Result<SlacNumerator>
  leg: SlacLeg
  strategies: number
}) {
  return (
    <div className="slac-card">
      <div className="slac-title">{title}</div>
      <div className="slac-value">
        {leg.ratio.ok ? (
          <span className="num">{ratio(leg.ratio.value)}</span>
        ) : (
          <>
            <span className="unavailable">undefined</span>
            <span className="why">{leg.ratio.reason}</span>
          </>
        )}
      </div>
      <dl className="kv slac-kv">
        <dt>provisioned</dt>
        <dd>
          {numerator.ok ? (
            <>
              {grouped(wholeTokens(numerator.value.total))}
              <span className="unit">
                tokens over {strategies} {strategies === 1 ? 'strategy' : 'strategies'}
                {numerator.value.missing ? `, ${numerator.value.missing} balance unread` : ''}
              </span>
            </>
          ) : (
            <span className="unavailable">{numerator.reason}</span>
          )}
        </dd>
        <dt>equity</dt>
        <dd>
          {leg.denominator.ok ? (
            <>
              {grouped(wholeTokens(leg.denominator.value))}
              <span className="unit">tokens</span>
            </>
          ) : (
            <span className="unavailable">{leg.denominator.reason}</span>
          )}
        </dd>
        <dt>denominator</dt>
        <dd className="faint">{denominator}</dd>
      </dl>
    </div>
  )
}

/** A fill, as its own receipt describes it. Nothing here is copied from what the solver printed. */
function FillReceiptView({ receipt, snapshot }: { receipt: FillReceipt; snapshot: Snapshot | null }) {
  const symbolOf = (address: Address | null | undefined) =>
    address && snapshot ? tokenOf(snapshot, address).symbol : ''
  const decimalsOf = (address: Address | null | undefined) =>
    address && snapshot ? tokenOf(snapshot, address).decimals : 18

  const decrease = receipt.positionCalls.find((call) => call.kind === 'decrease')
  const increase = receipt.positionCalls.find((call) => call.kind === 'increase')

  return (
    <>
      <dl className="kv">
        <dt>transaction</dt>
        <dd>
          <a href={txUrl(receipt.hash)} target="_blank" rel="noreferrer">
            {receipt.hash}
          </a>
          <span className="unit">
            {receipt.status === 'success' ? 'success' : 'reverted'}, block {receipt.blockNumber.toString()}, gas{' '}
            {integer(receipt.gasUsed)}
          </span>
        </dd>
        <dt>Swapped</dt>
        <dd>
          {receipt.swapped.ok ? (
            <>
              {fmtAmount(receipt.swapped.value.amountIn, decimalsOf(receipt.swapped.value.tokenIn), 6)}{' '}
              {symbolOf(receipt.swapped.value.tokenIn)} in, {' '}
              {fmtAmount(receipt.swapped.value.amountOut, decimalsOf(receipt.swapped.value.tokenOut), 6)}{' '}
              {symbolOf(receipt.swapped.value.tokenOut)} out
              <span className="unit">taker {short(receipt.swapped.value.taker, 8, 6)}</span>
            </>
          ) : (
            <span className="unavailable">{receipt.swapped.reason}</span>
          )}
        </dd>
        <dt>orderHash</dt>
        <dd className="faint">{receipt.swapped.ok ? receipt.swapped.value.orderHash : 'no Swapped event'}</dd>
      </dl>

      <div className="calls">
        <div className="call">
          <div className="call-head">
            <span className="call-index">1</span> preTransferOut, the unwind
            <span className="note">the /lp/decrease payload, executed by the vault against the PositionManager</span>
          </div>
          <dl className="kv">
            <dt>liquidity</dt>
            <dd>
              {receipt.liquidity.ok ? (
                <>
                  {liquidityText(receipt.liquidity.value.beforeUnwind)} to{' '}
                  {liquidityText(receipt.liquidity.value.afterUnwind)}
                  {decrease ? <span className="unit">delta -{liquidityText(decrease.liquidityDelta)}</span> : null}
                </>
              ) : (
                <span className="unavailable">{receipt.liquidity.reason}</span>
              )}
            </dd>
            <dt>released</dt>
            <dd>
              {receipt.unwound.ok ? (
                <>
                  {fmtAmount(receipt.unwound.value.released, decimalsOf(receipt.unwound.value.token), 6)}{' '}
                  {symbolOf(receipt.unwound.value.token)}
                  <span className="unit">
                    against {fmtAmount(receipt.unwound.value.required, decimalsOf(receipt.unwound.value.token), 6)}{' '}
                    owed, the surplus stays as float
                  </span>
                </>
              ) : (
                <span className="unavailable">{receipt.unwound.reason}</span>
              )}
            </dd>
          </dl>
        </div>
        <div className="call">
          <div className="call-head">
            <span className="call-index">2</span> postTransferIn, the redeposit
            <span className="note">the /lp/increase payload, same transaction, after the taker was paid</span>
          </div>
          <dl className="kv">
            <dt>liquidity</dt>
            <dd>
              {receipt.redeposited.ok ? (
                <>
                  {liquidityText(receipt.redeposited.value.liquidityBefore)} to{' '}
                  {liquidityText(receipt.redeposited.value.liquidityAfter)}
                  {increase ? <span className="unit">delta +{liquidityText(increase.liquidityDelta)}</span> : null}
                </>
              ) : (
                <span className="unavailable">{receipt.redeposited.reason}</span>
              )}
            </dd>
            <dt>PoolManager</dt>
            <dd>
              {receipt.positionCalls.length ? (
                <>
                  {receipt.positionCalls.length} ModifyLiquidity
                  <span className="unit">
                    sent by {short(receipt.positionCalls[0].sender, 8, 6)}, the position manager
                  </span>
                </>
              ) : (
                <span className="unavailable">no ModifyLiquidity event in this receipt</span>
              )}
            </dd>
          </dl>
        </div>
      </div>
    </>
  )
}

export function Dashboard({ config, wallet }: { config: AppConfig | null; wallet: Wallet }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [live, setLive] = useState(true)

  const [history, setHistory] = useState<History | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [probe, setProbe] = useState<SolverProbe | null>(null)

  const [amountInput, setAmountInput] = useState('1000')
  const [aToB, setAToB] = useState(true)
  const [dryRun, setDryRun] = useState(false)

  const [quote, setQuote] = useState<Action<QuoteResult>>(idle)
  const [fill, setFill] = useState<Action<FillResult>>(idle)
  const [progress, setProgress] = useState<{ steps: FillStep[]; log: string[] }>({ steps: [], log: [] })
  const [claim, setClaim] = useState<Action<{ tx: TransactionRequest | null; payload: unknown }>>(idle)
  const [unwind, setUnwind] = useState<Action<{ tx: TransactionRequest | null; payload: unknown }>>(idle)
  const [execution, setExecution] = useState<Action<{ hash: Hex }>>(idle)
  const [apiPool, setApiPool] = useState<Record<string, string | number> | null>(null)

  const [receiptHash, setReceiptHash] = useState<Hex | null>(null)
  const [ranHere, setRanHere] = useState(false)
  const [receipt, setReceipt] = useState<Action<FillReceipt>>(idle)

  const chainId = config?.deployment.chainId ?? config?.chain.chainId ?? CHAIN.id
  const wiring = useMemo(() => fillWiring(probe), [probe])

  const historyRef = useRef<History | null>(null)
  const poolInfoAt = useRef(0)
  const poolIdRef = useRef<Hex | null>(null)
  poolIdRef.current = snapshot?.uniswap.poolId ?? null

  const refresh = useCallback(
    async (options: { withApi?: boolean } = {}) => {
      if (!config) return
      setRefreshing(true)
      try {
        // Every strategy the vault has ever shipped, so the metric above the columns is a sum over all of them
        // and not over the one the record happens to name.
        const hashes = historyRef.current?.strategies.map((strategy) => strategy.hash) ?? []
        const next = await readSnapshot(config, hashes)
        setSnapshot(next)
        setSnapshotError(null)
        // A manual refresh also asks the Uniswap API about the pool, which puts a real request and a real
        // response in the network panel every time somebody presses the button. The auto refresh does not,
        // because the key is rate limited to six requests a second and a demo should not spend that.
        if (options.withApi && Date.now() - poolInfoAt.current > POOL_INFO_MIN_GAP_MS) {
          poolInfoAt.current = Date.now()
          const key = next.vault.keyUsed
          const result = await poolInfo({
            chainId,
            tokenA: key.currency0,
            tokenB: key.currency1,
            fee: key.fee,
            tickSpacing: key.tickSpacing,
            hooks: key.hooks,
          }).catch(() => null)
          const pools = (result?.payload as { pools?: Array<Record<string, string | number>> } | undefined)?.pools
          setApiPool(pools?.length ? pools[0] : null)
        }
      } catch (error) {
        setSnapshotError(reason(error))
      } finally {
        setRefreshing(false)
      }
    },
    [chainId, config],
  )

  const scanHistory = useCallback(async () => {
    const vault = config?.deployment.vault
    const router = config?.deployment.router
    if (!vault || !router) return
    try {
      const next = await readHistory({ vault, router })
      historyRef.current = next
      setHistory(next)
      setHistoryError(next.error)
    } catch (error) {
      setHistoryError(reason(error))
    }
  }, [config])

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const scanRef = useRef(scanHistory)
  scanRef.current = scanHistory

  // The log scan runs first, because the strategies it finds are what the snapshot then reads balances for.
  useEffect(() => {
    void scanHistory().then(() => refreshRef.current())
  }, [scanHistory])

  useEffect(() => {
    if (!live) return
    const state = setInterval(() => void refreshRef.current(), STATE_POLL_MS)
    const logs = setInterval(() => void scanRef.current(), HISTORY_POLL_MS)
    return () => {
      clearInterval(state)
      clearInterval(logs)
    }
  }, [live])

  useEffect(() => {
    let cancelled = false
    const ask = () => {
      void probeSolver().then((result) => {
        if (!cancelled) setProbe(result)
      })
    }
    ask()
    const timer = setInterval(ask, SOLVER_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // The last fill the deployment record names, so the panel shows a real transaction before anybody presses
  // anything. A fill run from this page replaces it.
  useEffect(() => {
    const recorded = config?.deployment.lastFill?.txHash ?? null
    if (recorded && !receiptHash) setReceiptHash(recorded)
  }, [config, receiptHash])

  useEffect(() => {
    const router = config?.deployment.router
    const vault = config?.deployment.vault
    if (!receiptHash || !router || !vault) return
    let cancelled = false
    setReceipt({ status: 'pending' })
    readFillReceipt(receiptHash, {
      router,
      vault,
      poolManager: config?.chain.poolManager ?? config?.deployment.poolManager ?? null,
      positionManager: config?.deployment.positionManager ?? config?.chain.positionManager ?? null,
      poolId: poolIdRef.current,
    })
      .then((value) => {
        if (!cancelled) setReceipt({ status: 'ok', value })
      })
      .catch((error) => {
        if (!cancelled) setReceipt({ status: 'error', message: reason(error) })
      })
    return () => {
      cancelled = true
    }
  }, [config, receiptHash])

  const decimalsA = snapshot?.tokenA.decimals.ok ? snapshot.tokenA.decimals.value : 18
  const decimalsB = snapshot?.tokenB.decimals.ok ? snapshot.tokenB.decimals.value : 18
  const symbolA = snapshot?.tokenA.symbol.ok ? snapshot.tokenA.symbol.value : 'token A'
  const symbolB = snapshot?.tokenB.symbol.ok ? snapshot.tokenB.symbol.value : 'token B'
  // `isAToB` is a taker trait, and the VM reads it against the order's own tokens, which are stored sorted.
  // So the direction is token0 to token1 and not tokenA to tokenB: on this pair the two are not the same, and
  // labelling it from the deployment record would name the wrong side of every fill.
  const token0 = snapshot?.vault.keyUsed.currency0 ?? null
  const token1 = snapshot?.vault.keyUsed.currency1 ?? null
  const metaOf = (token: Address | null) =>
    snapshot && token ? tokenOf(snapshot, token) : { symbol: 'token', decimals: 18 }
  const symbol0 = token0 ? metaOf(token0).symbol : 'token0'
  const symbol1 = token1 ? metaOf(token1).symbol : 'token1'
  const inMeta = metaOf(aToB ? token0 : token1)
  const outMeta = metaOf(aToB ? token1 : token0)
  const inSymbol = inMeta.symbol
  const outSymbol = outMeta.symbol
  const inDecimals = inMeta.decimals
  const outDecimals = outMeta.decimals

  const tokenId = snapshot?.uniswap.tokenId ?? null
  const vaultAddress = config?.deployment.vault ?? null
  const positionManager = config?.deployment.positionManager ?? config?.chain.positionManager ?? null
  const orderResult = config ? orderFrom(config.deployment) : null

  const isVaultOwner =
    wallet.state && snapshot?.vault.owner.ok
      ? wallet.state.address.toLowerCase() === snapshot.vault.owner.value.toLowerCase()
      : false

  const slac = useMemo(() => slacOf(snapshot), [snapshot])

  /**
   * Settled volume, per input token, so a two directional book is never summed into one wrong number.
   *
   * Derived from the logs alone. The token metadata comes from the snapshot when it has arrived, and from the
   * address itself when it has not, because the volume is a fact about the chain either way.
   */
  const volume = useMemo(() => {
    if (!history) return null
    const paidIn = new Map<string, bigint>()
    const paidOut = new Map<string, bigint>()
    for (const entry of history.fills) {
      paidIn.set(entry.tokenIn, (paidIn.get(entry.tokenIn) ?? 0n) + entry.amountIn)
      paidOut.set(entry.tokenOut, (paidOut.get(entry.tokenOut) ?? 0n) + entry.amountOut)
    }
    const legs = (totals: Map<string, bigint>) =>
      [...totals.entries()].map(([token, value]) => ({
        token: token as Address,
        value,
        symbol: snapshot ? tokenOf(snapshot, token as Address).symbol : short(token, 6, 4),
        decimals: snapshot ? tokenOf(snapshot, token as Address).decimals : 18,
      }))
    return { count: settled(history.fills).count, in: legs(paidIn), out: legs(paidOut) }
  }, [history, snapshot])

  const float: Result<bigint> = useMemo(() => {
    if (!snapshot) return notRead
    if (!snapshot.vault.floatA.ok) return snapshot.vault.floatA
    if (!snapshot.vault.floatB.ok) return snapshot.vault.floatB
    return ok(snapshot.vault.floatA.value + snapshot.vault.floatB.value)
  }, [snapshot])

  const onQuote = useCallback(async () => {
    if (!config?.deployment.router || !orderResult) return
    if (!orderResult.ok) {
      setQuote({ status: 'error', message: orderResult.reason })
      return
    }
    setQuote({ status: 'pending' })
    try {
      const value = await requestQuote({
        router: config.deployment.router,
        order: orderResult.value,
        amount: parseUnits(amountInput || '0', inDecimals),
        isExactIn: true,
        isAToB: aToB,
        takerTraitsAndData: config.deployment.takerTraitsAndData,
      })
      setQuote({ status: 'ok', value })
    } catch (error) {
      setQuote({ status: 'error', message: reason(error) })
    }
  }, [aToB, amountInput, config, inDecimals, orderResult])

  const onFill = useCallback(async () => {
    setFill({ status: 'pending' })
    setProgress({ steps: [], log: [] })
    try {
      const value = await runFill({
        amount: parseUnits(amountInput || '0', inDecimals),
        isExactIn: true,
        isAToB: aToB,
        taker: (wallet.state?.address ?? config?.deployment.deployer) as Address | undefined,
        dry: dryRun,
        onEvent: (event) => {
          if (event.type === 'step') {
            setProgress((current) => ({
              ...current,
              steps: [...current.steps, { index: event.index, label: event.label, at: Date.now() }],
            }))
          }
          if (event.type === 'log') {
            setProgress((current) => ({ ...current, log: [...current.log, event.line].slice(-400) }))
          }
        },
      })
      setFill({ status: 'ok', value })
      if (value.transactionHash) {
        setReceiptHash(value.transactionHash)
        setRanHere(true)
      }
      void refresh()
      void scanHistory()
    } catch (error) {
      setFill({ status: 'error', message: reason(error) })
    }
  }, [aToB, amountInput, config, dryRun, inDecimals, refresh, scanHistory, wallet.state])

  const onClaimFees = useCallback(async () => {
    if (!vaultAddress) return
    if (tokenId === null) {
      setClaim({
        status: 'error',
        message: 'no position yet, so there is no tokenId to claim fees on. The setup script creates it.',
      })
      return
    }
    setClaim({ status: 'pending' })
    setExecution(idle)
    try {
      const key = snapshot!.vault.keyUsed
      const { payload } = await claimFees({
        chainId,
        walletAddress: vaultAddress,
        tokenId: tokenId.toString(),
        token0: key.currency0,
        token1: key.currency1,
      })
      setClaim({ status: 'ok', value: { tx: findTransactionRequest(payload), payload } })
    } catch (error) {
      setClaim({ status: 'error', message: reason(error) })
    }
  }, [chainId, snapshot, tokenId, vaultAddress])

  const onUnwindCalldata = useCallback(async () => {
    if (!vaultAddress || !snapshot) return
    if (tokenId === null) {
      setUnwind({ status: 'error', message: 'no position yet, /lp/decrease needs a tokenId' })
      return
    }
    setUnwind({ status: 'pending' })
    try {
      const key = snapshot.vault.keyUsed
      const percent = snapshot.vault.maxUnwindPct.ok ? snapshot.vault.maxUnwindPct.value : 1
      const { payload } = await decrease({
        chainId,
        walletAddress: vaultAddress,
        tokenId: tokenId.toString(),
        token0: key.currency0,
        token1: key.currency1,
        percent,
      })
      setUnwind({ status: 'ok', value: { tx: findTransactionRequest(payload), payload } })
    } catch (error) {
      setUnwind({ status: 'error', message: reason(error) })
    }
  }, [chainId, snapshot, tokenId, vaultAddress])

  const onExecuteClaim = useCallback(async () => {
    if (claim.status !== 'ok' || !claim.value.tx || !vaultAddress || !wallet.state) return
    setExecution({ status: 'pending' })
    try {
      const client = walletClientFor(wallet.state.address as Address)
      const hash = await client.writeContract({
        account: wallet.state.address as Address,
        chain: CHAIN,
        address: vaultAddress,
        abi: vaultAbi,
        functionName: 'executeOnPositionManager',
        args: [claim.value.tx.data as Hex, 0n],
      })
      setExecution({ status: 'ok', value: { hash } })
      await publicClient.waitForTransactionReceipt({ hash })
      void refresh()
    } catch (error) {
      setExecution({ status: 'error', message: reason(error) })
    }
  }, [claim, refresh, vaultAddress, wallet.state])

  const quoteDisabledReason = !config
    ? 'the address files are still loading'
    : orderResult && !orderResult.ok
      ? orderResult.reason
      : null

  /** Where each strategy came from, and what it has settled, keyed by hash. */
  const strategyMeta = useMemo(() => {
    const map = new Map<string, { blockNumber: bigint; txHash: Hex; fills: number }>()
    for (const strategy of history?.strategies ?? []) {
      map.set(strategy.hash.toLowerCase(), { blockNumber: strategy.blockNumber, txHash: strategy.txHash, fills: 0 })
    }
    for (const entry of history?.fills ?? []) {
      const meta = map.get(entry.orderHash.toLowerCase())
      if (meta) meta.fills += 1
    }
    return map
  }, [history])

  const liveStrategyHash = config?.deployment.strategy?.orderHash ?? config?.deployment.strategyHash ?? null

  return (
    <div className="wrap dash">
      {snapshotError ? <div className="banner bad">state could not be read: {snapshotError}</div> : null}
      {config?.problems.length ? <div className="banner">{config.problems.join(' , ')}</div> : null}

      <div className="actionbar">
        <div>
          <label className="field-label" htmlFor="amount">
            amount in, {inSymbol}
          </label>
          <input
            id="amount"
            className="input"
            style={{ width: 130 }}
            value={amountInput}
            onChange={(event) => setAmountInput(event.target.value)}
            inputMode="decimal"
          />
        </div>
        <div>
          <label className="field-label" htmlFor="direction">
            direction
          </label>
          <select
            id="direction"
            className="select"
            value={aToB ? 'ab' : 'ba'}
            onChange={(event) => setAToB(event.target.value === 'ab')}
          >
            <option value="ab">
              {symbol0} to {symbol1}
            </option>
            <option value="ba">
              {symbol1} to {symbol0}
            </option>
          </select>
        </div>

        <button className="btn" onClick={() => void refresh({ withApi: true })} disabled={refreshing || !config}>
          {refreshing ? 'reading' : 'Refresh state'}
        </button>
        <button
          className="btn"
          onClick={() => void onQuote()}
          disabled={quote.status === 'pending' || Boolean(quoteDisabledReason)}
          title={quoteDisabledReason ?? 'staticcall on quote(), instruction 0x92 runs inside it'}
        >
          Request a quote
        </button>
        <button
          className="btn primary"
          onClick={() => void onFill()}
          disabled={fill.status === 'pending'}
          title={wiring.detail}
        >
          {fill.status === 'pending' ? 'filling' : dryRun ? 'Run a fill, dry' : 'Run a fill'}
        </button>
        <label className="toggle" title="simulate against live state and broadcast nothing, yarn fill --dry">
          <input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} />
          dry
        </label>
        <button className="btn" onClick={() => void onClaimFees()} disabled={claim.status === 'pending'}>
          Claim fees
        </button>

        <div className="spacer" />
        <label className="toggle">
          <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
          auto refresh, 5 s
        </label>
        <span className={wiring.wired ? 'chip' : 'chip warn'} title={wiring.detail}>
          <span className="led" /> solver {wiring.wired ? 'up' : 'down'}
        </span>
        <span className="chip" title="block the last read was answered at">
          <span className="led" />
          <Show result={snapshot?.blockNumber ?? notRead}>{(value) => <>block {integer(value)}</>}</Show>
        </span>
        {snapshot ? <span className="chip">{ago(snapshot.at)}</span> : null}
      </div>

      {/* the two figures ---------------------------------------------------- */}
      <section className="headline">
        <Figure
          label="settled through this maker"
          note="Swapped events on the router, summed per input token"
          sub={
            volume
              ? `${volume.count} ${volume.count === 1 ? 'fill' : 'fills'}, paid back out: ${volume.out
                  .map((leg) => `${fmtAmount(leg.value, leg.decimals, 2)} ${leg.symbol}`)
                  .join(' , ') || 'nothing yet'}`
              : 'reading the logs'
          }
        >
          {volume && volume.in.length ? (
            volume.in.map((leg) => (
              <div key={leg.token}>
                <span className="num">{fmtAmount(leg.value, leg.decimals, 2)}</span> <Unit>{leg.symbol}</Unit>
              </div>
            ))
          ) : history ? (
            <>
              <span className="unavailable">no fill in the scanned window</span>
              <span className="why">
                scanned back to block {history.scannedFrom.toString()} over {history.chunks} range
                {history.chunks === 1 ? '' : 's'}
              </span>
            </>
          ) : (
            <span className="unavailable">reading</span>
          )}
        </Figure>

        <Figure
          label="the float that backed it"
          note="balanceOf the vault, both tokens, right now"
          sub={
            snapshot?.vault.floatA.ok && snapshot.vault.floatB.ok
              ? `${fmtAmount(snapshot.vault.floatA.value, decimalsA, 2)} ${symbolA} , ${fmtAmount(snapshot.vault.floatB.value, decimalsB, 2)} ${symbolB}`
              : 'not read yet'
          }
        >
          <Show result={float}>
            {(value) => (
              <>
                <span className="num">{fmtAmount(value, 18, 2)}</span> <Unit>tokens</Unit>
              </>
            )}
          </Show>
        </Figure>

        <div className="headline-note">
          The number on the right is what a wallet balance check sees. The volume on the left went through that
          same wallet anyway, because the inventory sits in a Uniswap v4 position and is unwound one instruction
          before the tokens leave, inside the transaction that pays them out.
        </div>
      </section>

      {/* SLAC --------------------------------------------------------------- */}
      <section className="slac">
        <div className="slac-head">
          <h3>SLAC</h3>
          <span className="faint">
            the Shared Liquidity Amplification Coefficient, 1inch's own metric, Aqua whitepaper page 4: total
            liquidity provisioned across all strategies over the wallet equity backing it
          </span>
        </div>
        <div className="slac-grid">
          <SlacCard
            title="against bare wallet equity"
            denominator="ERC20 balanceOf on the vault, both tokens"
            numerator={slac.numerator}
            leg={slac.bare}
            strategies={snapshot?.aqua.strategies.length ?? 0}
          />
          <SlacCard
            title="against reachable equity"
            denominator="free float plus vault.reachableFromPosition(), counted once"
            numerator={slac.numerator}
            leg={slac.reachable}
            strategies={snapshot?.aqua.strategies.length ?? 0}
          />
        </div>
        <p className="slac-foot">
          The second denominator is what the custom instruction measures on chain. reachableFromPosition() is the
          position's liquidity valued at the maker's own conversion factor, capped at maxUnwindPct and cut by the
          haircut, and instruction 0x92 clamps every quote to the free float plus that figure inside the VM. The
          first denominator is the one a wallet balance check would use, which is why it reads as amplification
          that cannot exist: the inventory it is looking for is deployed, not missing.
        </p>
      </section>

      <div className="results">
        <ResultCard title="quote" state={quote}>
          {quote.status === 'ok' ? (
            <dl className="kv">
              <dt>amountIn</dt>
              <dd>
                {fmtAmount(quote.value.amountIn, inDecimals, 6)} {inSymbol}
              </dd>
              <dt>amountOut</dt>
              <dd>
                {fmtAmount(quote.value.amountOut, outDecimals, 6)} {outSymbol}
              </dd>
              <dt>orderHash</dt>
              <dd>{quote.value.orderHash}</dd>
              <dt>takerTraits</dt>
              <dd>{quote.value.takerTraitsAndData}</dd>
              <dt>raw</dt>
              <dd className="faint">
                {quote.value.amountIn.toString()} in, {quote.value.amountOut.toString()} out, read through a
                staticcall on quote()
              </dd>
            </dl>
          ) : null}
        </ResultCard>

        {fill.status !== 'idle' ? (
          <div
            className={
              fill.status === 'ok' ? 'result ok' : fill.status === 'error' ? 'result error' : 'result pending'
            }
          >
            <h4>fill</h4>
            {progress.steps.length ? (
              <ol className="steps">
                {progress.steps.map((step) => (
                  <li key={`${step.index}-${step.at}`}>
                    <span className="num">{step.index}</span> {step.label}
                  </li>
                ))}
              </ol>
            ) : null}
            {fill.status === 'pending' ? (
              <div className="muted">
                the solver is running solver/src/fill.ts, which is what yarn fill runs: a quote, two Uniswap API
                calls, a Foundry simulation, then the broadcast.
              </div>
            ) : null}
            {fill.status === 'error' ? (
              <div className="mono" style={{ overflowWrap: 'anywhere' }}>
                {fill.message}
              </div>
            ) : null}
            {fill.status === 'ok' ? (
              <dl className="kv">
                <dt>{fill.value.dry ? 'simulated' : 'transaction'}</dt>
                <dd>
                  {fill.value.transactionHash ? (
                    <a href={txUrl(fill.value.transactionHash)} target="_blank" rel="noreferrer">
                      {fill.value.transactionHash}
                    </a>
                  ) : (
                    <span className="faint">
                      dry run, nothing was broadcast. The same press with the dry box clear sends it.
                    </span>
                  )}
                </dd>
                <dt>quoted</dt>
                <dd>
                  {fill.value.amountIn === null ? 'unavailable' : fmtAmount(fill.value.amountIn, inDecimals, 6)}{' '}
                  {inSymbol} in,{' '}
                  {fill.value.amountOut === null ? 'unavailable' : fmtAmount(fill.value.amountOut, outDecimals, 6)}{' '}
                  {outSymbol} out
                </dd>
                <dt>unwind</dt>
                <dd>
                  {fill.value.unwindPercent} percent of the position
                  <span className="unit">rounded up, liquidityPercentageToDecrease is an integer</span>
                </dd>
                <dt>sent from</dt>
                <dd>
                  {fill.value.taker ? (
                    <Addr value={fill.value.taker} length={10} />
                  ) : (
                    <span className="faint">the solver key</span>
                  )}
                  <span className="unit">the solver signs with the key it holds, not with the browser wallet</span>
                </dd>
                <dt>command</dt>
                <dd className="faint">{fill.value.command ?? 'yarn fill'}</dd>
              </dl>
            ) : null}
            {progress.log.length ? (
              <details style={{ marginTop: 10 }}>
                <summary className="faint">solver output, {progress.log.length} lines</summary>
                <pre className="json">{progress.log.join('\n')}</pre>
              </details>
            ) : null}
          </div>
        ) : null}

        <ResultCard
          title={ranHere ? 'the fill, read back from its receipt' : 'the last fill on this vault, from its receipt'}
          state={receipt}
        >
          {receipt.status === 'ok' ? <FillReceiptView receipt={receipt.value} snapshot={snapshot} /> : null}
        </ResultCard>

        <ResultCard title="claim fees, /lp/claim_fees" state={claim}>
          {claim.status === 'ok' ? (
            <>
              <TxRequestView tx={claim.value.tx} expected={positionManager} />
              <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  className="btn small"
                  onClick={() => void onExecuteClaim()}
                  disabled={!claim.value.tx || !isVaultOwner || execution.status === 'pending'}
                  title={
                    isVaultOwner
                      ? 'sends vault.executeOnPositionManager with the calldata the API built'
                      : 'executeOnPositionManager is onlyOwner, so this needs the vault owner in the wallet'
                  }
                >
                  Execute through the vault
                </button>
                {!isVaultOwner ? (
                  <span className="faint">
                    the connected wallet is not the vault owner, so the vault would reject the call
                  </span>
                ) : null}
                {execution.status === 'ok' ? (
                  <a href={txUrl(execution.value.hash)} target="_blank" rel="noreferrer" className="mono">
                    {short(execution.value.hash, 10, 8)}
                  </a>
                ) : null}
                {execution.status === 'error' ? <span className="unavailable">{execution.message}</span> : null}
              </div>
              <details style={{ marginTop: 10 }}>
                <summary className="faint">raw response</summary>
                <pre className="json">{stringify(claim.value.payload)}</pre>
              </details>
            </>
          ) : null}
        </ResultCard>

        <ResultCard title="unwind calldata, /lp/decrease" state={unwind}>
          {unwind.status === 'ok' ? (
            <>
              <p className="muted" style={{ marginBottom: 8 }}>
                This is the payload that goes verbatim into the preTransferOutHookData slice of the taker traits
                and is executed by the vault one instruction before the tokens leave.
              </p>
              <TxRequestView tx={unwind.value.tx} expected={positionManager} />
            </>
          ) : null}
        </ResultCard>
      </div>

      <div className="columns">
        <section className="column uniswap">
          <div className="column-head">
            <h3>Uniswap v4 position</h3>
            <span className="who">
              {positionManager ? <Addr value={positionManager} /> : <span className="unavailable">no manager</span>}
            </span>
          </div>
          <div className="column-body">
            <Metric label="tokenId" note={snapshot?.uniswap.tokenIdSource ?? undefined} big>
              {tokenId === null ? (
                <>
                  <span className="unavailable">unavailable</span>
                  <span className="why">
                    the position does not exist yet. The setup script creates it through the Uniswap API and hands
                    it to the vault.
                  </span>
                </>
              ) : (
                <span className="num">{tokenId.toString()}</span>
              )}
            </Metric>
            <Metric label="live liquidity" note="getPositionLiquidity(uint256), 0x1efeed33" big>
              <Show result={snapshot?.uniswap.liquidity ?? notRead}>
                {(value) => (
                  <span className="num" title={`${value.toString()} raw`}>
                    {liquidityText(value)}
                  </span>
                )}
              </Show>
            </Metric>
            <Metric label="current tick" note="StateView.getSlot0">
              <Show result={snapshot?.uniswap.tick ?? notRead}>{(value) => <span className="num">{value}</span>}</Show>
            </Metric>
            <Metric label="tick bounds" note="getPoolAndPositionInfo, the position's own range">
              {snapshot?.uniswap.tickLower.ok && snapshot.uniswap.tickUpper.ok ? (
                <span className="num">
                  {snapshot.uniswap.tickLower.value} to {snapshot.uniswap.tickUpper.value}
                  <Unit>
                    {snapshot.uniswap.tickLower.value <= -887220 && snapshot.uniswap.tickUpper.value >= 887220
                      ? 'full range'
                      : 'bounded'}
                  </Unit>
                </span>
              ) : (
                <Show result={snapshot?.uniswap.tickLower ?? notRead}>
                  {(value) => <span className="num">{value}</span>}
                </Show>
              )}
            </Metric>
            <Metric label="fee tier" note="the pool key the position was opened on">
              {snapshot ? (
                <span className="num">
                  {snapshot.vault.keyUsed.fee}
                  <Unit>
                    {(snapshot.vault.keyUsed.fee / 10_000).toFixed(2)} percent, spacing{' '}
                    {snapshot.vault.keyUsed.tickSpacing}
                  </Unit>
                </span>
              ) : (
                <span className="unavailable">unavailable</span>
              )}
            </Metric>
            <Metric label="lp fee, live" note="StateView.getSlot0, hundredths of a bip">
              <Show result={snapshot?.uniswap.lpFee ?? notRead}>{(value) => <span className="num">{value}</span>}</Show>
            </Metric>
            <Metric label="pool liquidity" note="StateView.getLiquidity">
              <Show result={snapshot?.uniswap.poolLiquidity ?? notRead}>
                {(value) => (
                  <span className="num" title={`${value.toString()} raw`}>
                    {liquidityText(value)}
                  </span>
                )}
              </Show>
            </Metric>
            <Metric label="hook" note="no hook on this pool, the maker is not one">
              {snapshot ? (
                <Addr value={snapshot.vault.keyUsed.hooks} />
              ) : (
                <span className="unavailable">unavailable</span>
              )}
            </Metric>
            <Metric label="position owner">
              <Show result={snapshot?.uniswap.positionOwner ?? notRead}>
                {(value) => (
                  <>
                    <Addr value={value} />
                    {vaultAddress && value.toLowerCase() === vaultAddress.toLowerCase() ? (
                      <span className="unit">the vault</span>
                    ) : null}
                  </>
                )}
              </Show>
            </Metric>
            <Metric label="poolId">
              {snapshot?.uniswap.poolId ? (
                <span className="num" title={snapshot.uniswap.poolId}>
                  {short(snapshot.uniswap.poolId, 10, 6)}
                </span>
              ) : (
                <>
                  <span className="unavailable">unavailable</span>
                  <span className="why">derived from the position pool key, which needs a live position</span>
                </>
              )}
            </Metric>
            <div className="subhead">the same pool, as the Uniswap API reports it</div>
            {apiPool ? (
              <>
                <Metric label="current tick" note="POST /lp/pool_info">
                  <span className="num">{String(apiPool.currentTick)}</span>
                </Metric>
                <Metric label="pool liquidity" note="POST /lp/pool_info">
                  <span className="num">{integer(BigInt(String(apiPool.poolLiquidity ?? 0)))}</span>
                </Metric>
                <Metric label="token reserves" note="token0 and token1, from the API">
                  <span className="num">
                    {fmtAmount(BigInt(String(apiPool.token0Reserves ?? 0)), decimalsA)} /{' '}
                    {fmtAmount(BigInt(String(apiPool.token1Reserves ?? 0)), decimalsB)}
                  </span>
                </Metric>
              </>
            ) : (
              <div className="empty">
                Press Refresh state to ask /lp/pool_info about this pool. The request and the response land in the
                panel at the bottom. It is never called on a timer: the key allows six requests a second.
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              <button className="btn small" onClick={() => void onUnwindCalldata()} disabled={unwind.status === 'pending'}>
                Build unwind calldata
              </button>
              <span className="faint" style={{ marginLeft: 8, fontSize: 12 }}>
                calls /lp/decrease for real
              </span>
            </div>
          </div>
        </section>

        <section className="column vault">
          <div className="column-head">
            <h3>BebecitaVault, the maker</h3>
            <span className="who">
              {vaultAddress ? <Addr value={vaultAddress} /> : <span className="unavailable">no vault</span>}
            </span>
          </div>
          <div className="column-body">
            <Metric label={`free float, ${symbolA}`} note="balanceOf the vault" big>
              <Show result={snapshot?.vault.floatA ?? notRead}>
                {(value) => <span className="num">{fmtAmount(value, decimalsA, 4)}</span>}
              </Show>
            </Metric>
            <Metric label={`free float, ${symbolB}`} note="balanceOf the vault" big>
              <Show result={snapshot?.vault.floatB ?? notRead}>
                {(value) => <span className="num">{fmtAmount(value, decimalsB, 4)}</span>}
              </Show>
            </Metric>

            <div className="subhead">URC-3, hook TVL and effective liquidity reporting</div>
            <Metric
              label="reserves"
              note={
                snapshot
                  ? `getReserves(PoolKey), ${tokenOf(snapshot, snapshot.vault.keyUsed.currency0).symbol} and ${tokenOf(snapshot, snapshot.vault.keyUsed.currency1).symbol}`
                  : 'getReserves(PoolKey)'
              }
            >
              <Show result={snapshot?.vault.reserves ?? notRead}>
                {([token0, token1]) => (
                  <span className="num">
                    {fmtAmount(token0, snapshot ? tokenOf(snapshot, snapshot.vault.keyUsed.currency0).decimals : 18, 2)}
                    {' / '}
                    {fmtAmount(token1, snapshot ? tokenOf(snapshot, snapshot.vault.keyUsed.currency1).decimals : 18, 2)}
                  </span>
                )}
              </Show>
            </Metric>
            <Metric label="effective liquidity" note="getEffectiveLiquidity(PoolKey), what one fill can reach">
              <Show result={snapshot?.vault.effectiveLiquidity ?? notRead}>
                {([token0, token1]) => (
                  <span className="num">
                    {fmtAmount(token0, snapshot ? tokenOf(snapshot, snapshot.vault.keyUsed.currency0).decimals : 18, 2)}
                    {' / '}
                    {fmtAmount(token1, snapshot ? tokenOf(snapshot, snapshot.vault.keyUsed.currency1).decimals : 18, 2)}
                  </span>
                )}
              </Show>
            </Metric>
            <Metric label="invariant" note="effective liquidity must not exceed reserves">
              {snapshot?.vault.reserves.ok && snapshot.vault.effectiveLiquidity.ok ? (
                snapshot.vault.effectiveLiquidity.value[0] <= snapshot.vault.reserves.value[0] &&
                snapshot.vault.effectiveLiquidity.value[1] <= snapshot.vault.reserves.value[1] ? (
                  <span className="chip">
                    <span className="led" /> holds
                  </span>
                ) : (
                  <span className="chip bad">
                    <span className="led" /> violated
                  </span>
                )
              ) : (
                <span className="unavailable">unavailable</span>
              )}
            </Metric>

            <div className="subhead">what one fill may lean on</div>
            <Metric label="reachableFromPosition" note="the figure instruction 0x92 clamps to" big>
              <Show result={snapshot?.vault.reachable ?? notRead}>
                {(value) => <span className="num">{fmtAmount(value, decimalsB, 2)}</span>}
              </Show>
            </Metric>
            <Metric label="maxUnwindPct" note="largest share of the position one fill may unwind">
              <Show result={snapshot?.vault.maxUnwindPct ?? notRead}>
                {(value) => (
                  <span className="num">
                    {value} <Unit>percent</Unit>
                  </span>
                )}
              </Show>
            </Metric>
            <Metric label="haircutBps" note="safety margin on the deployed leg">
              <Show result={snapshot?.vault.haircutBps ?? notRead}>
                {(value) => (
                  <span className="num">
                    {value} <Unit>bps</Unit>
                  </span>
                )}
              </Show>
            </Metric>
            <Metric label="unitsPerLiquidityE18" note="tokenOut units per unit of position liquidity">
              <Show result={snapshot?.vault.unitsPerLiquidityE18 ?? notRead}>
                {(value) => <span className="num">{integer(value)}</span>}
              </Show>
            </Metric>
            <Metric label="pool key used" note={snapshot?.vault.keyFromPosition ? 'read from the position' : undefined}>
              {snapshot ? (
                snapshot.vault.keyFromPosition ? (
                  <span className="num">
                    fee {snapshot.vault.keyUsed.fee}, spacing {snapshot.vault.keyUsed.tickSpacing}
                  </span>
                ) : (
                  <>
                    <span className="unavailable">constructed</span>
                    <span className="why">
                      no position yet, so the key was built from the two token addresses. URC-3 only reads the
                      currencies off it, so the two numbers above are still honest.
                    </span>
                  </>
                )
              ) : (
                <span className="unavailable">unavailable</span>
              )}
            </Metric>
            <Metric label="owner">
              <Show result={snapshot?.vault.owner ?? notRead}>
                {(value) => (
                  <>
                    <Addr value={value} />
                    {isVaultOwner ? <span className="unit">your wallet</span> : null}
                  </>
                )}
              </Show>
            </Metric>
          </div>
        </section>

        <section className="column aqua">
          <div className="column-head">
            <h3>Aqua, official</h3>
            <span className="who">
              <Show result={snapshot?.aqua.address ?? notRead}>{(value) => <Addr value={value} />}</Show>
            </span>
          </div>
          <div className="column-body">
            <Metric label="router AQUA()" note="the one line that proves the official contract does the work">
              <Show result={snapshot?.aqua.routerAqua ?? notRead}>
                {(value) => (
                  <>
                    <Addr value={value} />
                    {snapshot?.aqua.address.ok && value.toLowerCase() === snapshot.aqua.address.value.toLowerCase() ? (
                      <span className="unit">matches the vault</span>
                    ) : null}
                  </>
                )}
              </Show>
            </Metric>
            <Metric label="custom opcode" note="OPCODE_UNWIND_PRICED_BALANCE_OUT()">
              <Show result={snapshot?.aqua.opcode ?? notRead}>
                {(value) => (
                  <span className="num">
                    {value.toString()} <Unit>0x{value.toString(16)}</Unit>
                  </span>
                )}
              </Show>
            </Metric>
            <Metric label="app" note="the router the strategies were shipped to">
              {snapshot?.aqua.app ? <Addr value={snapshot.aqua.app} /> : <span className="unavailable">unavailable</span>}
            </Metric>

            <div className="subhead">
              every strategy this vault has shipped
              {history ? (
                <span className="note">
                  Shipped events on the vault, blocks {history.scannedFrom.toString()} to {history.head.toString()}
                </span>
              ) : null}
            </div>
            {historyError ? (
              <div className="empty">
                <span className="unavailable">the log scan stopped early</span>
                <span className="why">{historyError}</span>
              </div>
            ) : null}
            {snapshot?.aqua.strategies.length ? (
              snapshot.aqua.strategies.map((strategy) => {
                const meta = strategyMeta.get(strategy.hash.toLowerCase())
                const isLive = liveStrategyHash?.toLowerCase() === strategy.hash.toLowerCase()
                const docked = strategy.balances.some((balance) => balance.raw.ok && balance.raw.value.tokensCount === 255)
                const subtotal = strategy.balances.reduce(
                  (total, balance) => total + (balance.raw.ok ? balance.raw.value.balance : 0n),
                  0n,
                )
                return (
                  <div className="strategy" key={strategy.hash}>
                    <div className="strategy-head">
                      <span className="hash" title={strategy.hash}>
                        {short(strategy.hash, 12, 8)}
                      </span>
                      {isLive ? <span className="chip">quoting now</span> : null}
                      {docked ? <span className="chip warn">docked</span> : null}
                    </div>
                    <div className="strategy-meta">
                      {meta ? (
                        <>
                          block {meta.blockNumber.toString()},{' '}
                          <a href={txUrl(meta.txHash)} target="_blank" rel="noreferrer" className="mono">
                            {short(meta.txHash, 8, 6)}
                          </a>
                          {meta.fills
                            ? ` , ${meta.fills} ${meta.fills === 1 ? 'fill' : 'fills'} settled`
                            : ' , no fill settled on it'}
                        </>
                      ) : (
                        <>named by deployments/sepolia.json, shipped outside the scanned log window</>
                      )}
                    </div>
                    {strategy.balances.map((balance) => (
                      <Metric
                        key={balance.token}
                        label={balance.symbol}
                        note="rawBalances(maker, app, strategyHash, token)"
                      >
                        <Show result={balance.raw}>
                          {(value) => (
                            <span className="num">
                              {fmtAmount(
                                value.balance,
                                balance.token.toLowerCase() === snapshot.tokenA.address.toLowerCase()
                                  ? decimalsA
                                  : decimalsB,
                                2,
                              )}
                              <Unit>tokensCount {value.tokensCount}</Unit>
                            </span>
                          )}
                        </Show>
                      </Metric>
                    ))}
                    <div className="strategy-total">
                      provisioned <span className="num">{fmtAmount(subtotal, 18, 0)}</span> tokens
                    </div>
                  </div>
                )
              })
            ) : (
              <div className="empty">
                No strategy found. The vault emits Shipped when it opens one, and this column reads the balances
                straight out of the official Aqua under that hash.
              </div>
            )}

            <div className="subhead">fill orchestration</div>
            <Metric label="Run a fill" note={wiring.wired ? solverUrl() : 'no solver answering'}>
              {wiring.wired ? (
                <span className="chip">
                  <span className="led" /> wired
                </span>
              ) : (
                <>
                  <span className="unavailable">not wired</span>
                  <span className="why">{wiring.detail}</span>
                </>
              )}
            </Metric>
            {probe?.ok && probe.busy ? (
              <Metric label="solver">
                <span className="chip warn">
                  <span className="led" /> a fill is already running
                </span>
              </Metric>
            ) : null}
            {config?.deployment.router ? (
              <Metric label="router">
                <a href={addressUrl(config.deployment.router)} target="_blank" rel="noreferrer" className="mono">
                  {short(config.deployment.router, 10, 6)}
                </a>
              </Metric>
            ) : null}
          </div>
        </section>
      </div>

      <NetworkPanel />
    </div>
  )
}
