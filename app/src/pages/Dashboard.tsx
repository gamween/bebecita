import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseUnits, type Address, type Hex } from 'viem'
import { useConnection, useWalletClient } from 'wagmi'

import { NetworkPanel } from '../components/NetworkPanel'
import {
  Addr,
  Field,
  Missing,
  Num,
  Panel,
  Show,
  StatedReasonsProvider,
  Subhead,
  TxLink,
  Unit,
} from '../components/primitives'
import { TxStatus } from '../components/Tx'
import { vaultAbi } from '../lib/abi'
import { CHAIN } from '../lib/client'
import type { AppConfig } from '../lib/config'
import { describeError } from '../lib/errors'
import {
  approveRouter,
  mintTo,
  readTakerPosition,
  runFill,
  type FillResult,
  type FillStep,
} from '../lib/fill'
import {
  amount as fmtAmount,
  exact,
  integer,
  ok,
  reason,
  shortAddress,
  shortHash,
  stringify,
  type Result,
} from '../lib/format'
import { readHistory, settled, type History } from '../lib/history'
import { orderFrom, requestQuote, type QuoteResult } from '../lib/quote'
import { readFillReceipt, type FillReceipt } from '../lib/receipt'
import { NOT_READ_YET, readinessOf } from '../lib/readiness'
import { ratio, slacOf, tokens as wholeTokens, type SlacLeg, type SlacNumerator } from '../lib/slac'
import { readSnapshot, tokenOf, type Snapshot } from '../lib/state'
import { txIdle, useTx, type TxState } from '../lib/tx'
import { claimFees, decrease, findTransactionRequest, poolInfo, type TransactionRequest } from '../lib/uniswap'

/** What Mint test tokens hands the connected wallet. Ten clips of the default size, so a demo does not repeat. */
const MINT_AMOUNT = 10_000n * 10n ** 18n

type Action<T> =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string }

const idle = { status: 'idle' } as const
const notRead: Result<never> = { ok: false, reason: NOT_READ_YET }
/**
 * Said once, on the taker subhead, and then treated as stated: the three fields under it are all about a
 * wallet that is not there, and the connect button in the top bar is the answer to all three.
 */
const NO_WALLET = 'no wallet connected, the connect button in the top bar makes it the taker of the fill'

/** Chain state. Five seconds is the polite end of live, and the Uniswap API is not touched by it. */
const STATE_POLL_MS = 5_000
/** Logs only move when a fill or a ship lands, so they are read on a slower loop. */
const HISTORY_POLL_MS = 60_000
/** The Uniswap key allows six requests a second. One pool_info per manual refresh, never on a render. */
const POOL_INFO_MIN_GAP_MS = 15_000

/** Position liquidity is a 1e18 scaled quantity, so it reads as a number rather than as a 24 digit integer. */
const liquidityText = (value: bigint) => fmtAmount(value < 0n ? -value : value, 18)

function ResultPanel({
  title,
  state,
  children,
}: {
  title: string
  state: Action<unknown>
  children?: React.ReactNode
}) {
  if (state.status === 'idle') return null
  const accent = state.status === 'ok' ? 'ok' : state.status === 'error' ? 'bad' : 'pending'
  return (
    <Panel accent={accent} title={title}>
      {state.status === 'pending' ? <div className="muted">waiting on the network</div> : null}
      {state.status === 'error' ? <div className="failure mono">{state.message}</div> : null}
      {state.status === 'ok' ? children : null}
    </Panel>
  )
}

function TxRequestView({ tx, expected }: { tx: TransactionRequest | null; expected: string | null }) {
  if (!tx) return <div className="muted">the response carried no transaction request</div>
  const pinned = expected && tx.to.toLowerCase() === expected.toLowerCase()
  return (
    <dl className="kv">
      <dt>to</dt>
      <dd>
        <Addr value={tx.to} />{' '}
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
        <Show result={leg.ratio}>{(value) => <span className="num">{ratio(value)}</span>}</Show>
      </div>
      <dl className="kv slac-kv">
        <dt>provisioned</dt>
        <dd>
          {numerator.ok ? (
            <>
              {integer(Math.round(wholeTokens(numerator.value.total)))}
              <span className="unit">
                tokens over {strategies} {strategies === 1 ? 'strategy' : 'strategies'}
                {numerator.value.missing ? `, ${numerator.value.missing} balance unread` : ''}
              </span>
            </>
          ) : (
            <Missing reason={numerator.reason} />
          )}
        </dd>
        <dt>equity</dt>
        <dd>
          {leg.denominator.ok ? (
            <>
              {integer(Math.round(wholeTokens(leg.denominator.value)))}
              <span className="unit">tokens</span>
            </>
          ) : (
            <Missing reason={leg.denominator.reason} />
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
          <TxLink hash={receipt.hash} />
          <span className="unit">
            {receipt.status === 'success' ? 'success' : 'reverted'}, block {integer(receipt.blockNumber)}, gas{' '}
            {integer(receipt.gasUsed)}
          </span>
        </dd>
        <dt>Swapped</dt>
        <dd>
          {receipt.swapped.ok ? (
            <>
              {fmtAmount(receipt.swapped.value.amountIn, decimalsOf(receipt.swapped.value.tokenIn))}{' '}
              {symbolOf(receipt.swapped.value.tokenIn)} in, {' '}
              {fmtAmount(receipt.swapped.value.amountOut, decimalsOf(receipt.swapped.value.tokenOut))}{' '}
              {symbolOf(receipt.swapped.value.tokenOut)} out
              <span className="unit">taker {shortAddress(receipt.swapped.value.taker)}</span>
            </>
          ) : (
            <Missing reason={receipt.swapped.reason} />
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
                <Missing reason={receipt.liquidity.reason} />
              )}
            </dd>
            <dt>released</dt>
            <dd>
              {receipt.unwound.ok ? (
                <>
                  {fmtAmount(receipt.unwound.value.released, decimalsOf(receipt.unwound.value.token))}{' '}
                  {symbolOf(receipt.unwound.value.token)}
                  <span className="unit">
                    against {fmtAmount(receipt.unwound.value.required, decimalsOf(receipt.unwound.value.token))}{' '}
                    owed, the surplus stays as float
                  </span>
                </>
              ) : (
                <Missing reason={receipt.unwound.reason} />
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
                <Missing reason={receipt.redeposited.reason} />
              )}
            </dd>
            <dt>PoolManager</dt>
            <dd>
              {receipt.positionCalls.length ? (
                <>
                  {receipt.positionCalls.length} ModifyLiquidity
                  <span className="unit">
                    sent by {shortAddress(receipt.positionCalls[0].sender)}, the position manager
                  </span>
                </>
              ) : (
                <Missing reason="no ModifyLiquidity event in this receipt" />
              )}
            </dd>
          </dl>
        </div>
      </div>
    </>
  )
}

export function Dashboard({ config }: { config: AppConfig | null }) {
  // The wallet, straight from wagmi. An account switch or a chain switch inside the extension re-renders this
  // page through these hooks, so nothing here has to listen to a provider or ask for a reload.
  const { address, chainId: walletChainId, status: walletStatus } = useConnection()
  const { data: walletClient } = useWalletClient()
  const takerAddress = (walletStatus === 'connected' ? (address as Address | undefined) : undefined) ?? null
  const wrongChain = walletStatus === 'connected' && walletChainId !== CHAIN.id

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [live, setLive] = useState(true)

  const [history, setHistory] = useState<History | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const [amountInput, setAmountInput] = useState('1000')
  const [aToB, setAToB] = useState(true)
  const [dryRun, setDryRun] = useState(false)

  const [quote, setQuote] = useState<Action<QuoteResult>>(idle)
  const [fill, setFill] = useState<Action<FillResult>>(idle)
  const [fillTx, setFillTx] = useState<TxState>(txIdle)
  const [progress, setProgress] = useState<{ steps: FillStep[]; log: string[] }>({ steps: [], log: [] })
  const [claim, setClaim] = useState<Action<{ tx: TransactionRequest | null; payload: unknown }>>(idle)
  const [unwind, setUnwind] = useState<Action<{ tx: TransactionRequest | null; payload: unknown }>>(idle)
  const [apiPool, setApiPool] = useState<Record<string, string | number> | null>(null)

  // The connected wallet is the taker now, so what it holds and what it has approved is part of the state
  // this page reads, and the two buttons that fix either are next to the fill.
  const [taker, setTaker] = useState<{ balance: bigint; allowance: bigint } | null>(null)
  const mintTx = useTx()
  const approveTx = useTx()
  const executeTx = useTx()

  const [receiptHash, setReceiptHash] = useState<Hex | null>(null)
  const [ranHere, setRanHere] = useState(false)
  const [receipt, setReceipt] = useState<Action<FillReceipt>>(idle)

  const chainId = config?.deployment.chainId ?? config?.chain.chainId ?? CHAIN.id

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
        if (!cancelled) setReceipt({ status: 'error', message: describeError(error) })
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
  const tokenIn = aToB ? token0 : token1
  const tokenOut = aToB ? token1 : token0
  const inMeta = metaOf(tokenIn)
  const outMeta = metaOf(tokenOut)
  const inSymbol = inMeta.symbol
  const outSymbol = outMeta.symbol
  const inDecimals = inMeta.decimals
  const outDecimals = outMeta.decimals

  const tokenId = snapshot?.uniswap.tokenId ?? null
  const vaultAddress = config?.deployment.vault ?? null
  const router = config?.deployment.router ?? null
  const positionManager = config?.deployment.positionManager ?? config?.chain.positionManager ?? null
  const orderResult = config ? orderFrom(config.deployment) : null

  /** What the connected wallet holds of the input token, and what it has approved the router for. */
  const refreshTaker = useCallback(async () => {
    if (!takerAddress || !tokenIn || !router) {
      setTaker(null)
      return
    }
    try {
      setTaker(await readTakerPosition({ taker: takerAddress, token: tokenIn, router }))
    } catch {
      setTaker(null)
    }
  }, [router, takerAddress, tokenIn])

  useEffect(() => {
    void refreshTaker()
  }, [refreshTaker, snapshot?.at])

  // A transaction belongs to the account that signed it. Switching account or disconnecting leaves the cards
  // from the previous one on screen, which reads as a failure that just happened, so they are cleared.
  const mintReset = mintTx.reset
  const approveReset = approveTx.reset
  const executeReset = executeTx.reset
  useEffect(() => {
    mintReset()
    approveReset()
    executeReset()
    setFillTx(txIdle)
  }, [approveReset, executeReset, mintReset, takerAddress])

  const isVaultOwner =
    takerAddress && snapshot?.vault.owner.ok
      ? takerAddress.toLowerCase() === snapshot.vault.owner.value.toLowerCase()
      : false

  const slac = useMemo(() => slacOf(snapshot), [snapshot])
  const readiness = useMemo(() => readinessOf(snapshot, snapshotError), [snapshot, snapshotError])
  // The taker fields say the same thing three times when nothing is connected, and the subhead above them
  // already says it once, so they render as placeholders instead.
  const statedReasons = useMemo(
    () => (takerAddress ? readiness.statedSet : new Set([...readiness.statedSet, NO_WALLET])),
    [readiness.statedSet, takerAddress],
  )

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
        symbol: snapshot ? tokenOf(snapshot, token as Address).symbol : shortAddress(token),
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
      setQuote({ status: 'error', message: describeError(error) })
    }
  }, [aToB, amountInput, config, inDecimals, orderResult])

  /**
   * Everything the fill needs that is not typed into the form, or a sentence saying what is missing.
   *
   * Nothing here is hardcoded: the addresses come from `deployments/sepolia.json`, the order comes from the
   * record the ship script published, and the two risk parameters are read off the vault itself rather than
   * off the record, so they are the numbers the guards will actually enforce.
   */
  const fillInputs = useMemo(():
    | { ok: true; value: Omit<Parameters<typeof runFill>[0], 'onEvent'> }
    | { ok: false; reason: string } => {
    if (!config || !snapshot) return { ok: false, reason: 'the chain state is still loading' }
    if (!takerAddress) return { ok: false, reason: 'connect a wallet, it is the taker and it signs the swap' }
    if (wrongChain) {
      return { ok: false, reason: `the wallet is on chain ${walletChainId}, this book lives on Sepolia` }
    }
    if (!walletClient) return { ok: false, reason: 'the wallet client is not ready yet' }
    if (!orderResult) return { ok: false, reason: 'no deployment record yet' }
    if (!orderResult.ok) return { ok: false, reason: orderResult.reason }
    if (!router || !vaultAddress || !positionManager) return { ok: false, reason: 'no router, vault or position manager in the record' }
    if (tokenId === null) return { ok: false, reason: 'no position yet, so there is nothing to unwind' }
    if (!token0 || !token1) return { ok: false, reason: 'the pool key has not been read yet' }
    if (!snapshot.vault.unitsPerLiquidityE18.ok) return { ok: false, reason: snapshot.vault.unitsPerLiquidityE18.reason }
    if (!snapshot.vault.maxUnwindPct.ok) return { ok: false, reason: snapshot.vault.maxUnwindPct.reason }
    if (!snapshot.vault.haircutBps.ok) return { ok: false, reason: snapshot.vault.haircutBps.reason }

    return {
      ok: true,
      value: {
        amount: parseUnits(amountInput || '0', inDecimals),
        isAToB: aToB,
        taker: takerAddress,
        wallet: walletClient,
        order: orderResult.value,
        orderHash: config.deployment.strategy?.orderHash ?? config.deployment.strategyHash,
        router,
        vault: vaultAddress,
        positionManager,
        tokenId,
        token0,
        token1,
        unitsPerLiquidityE18: snapshot.vault.unitsPerLiquidityE18.value,
        maxUnwindPct: snapshot.vault.maxUnwindPct.value,
        haircutBps: snapshot.vault.haircutBps.value,
        chainId,
        dry: dryRun,
      },
    }
  }, [
    aToB,
    amountInput,
    chainId,
    config,
    dryRun,
    inDecimals,
    orderResult,
    positionManager,
    router,
    snapshot,
    takerAddress,
    token0,
    token1,
    tokenId,
    vaultAddress,
    walletChainId,
    walletClient,
    wrongChain,
  ])

  const onFill = useCallback(async () => {
    if (!fillInputs.ok) {
      setFill({ status: 'error', message: fillInputs.reason })
      return
    }
    const dry = Boolean(fillInputs.value.dry)
    setFill({ status: 'pending' })
    setFillTx(dry ? txIdle : { status: 'signing' })
    setProgress({ steps: [], log: [] })
    let sent: Hex | null = null
    try {
      const value = await runFill({
        ...fillInputs.value,
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
          if (event.type === 'sent') {
            sent = event.hash
            setFillTx({ status: 'pending', hash: event.hash })
          }
        },
      })
      setFill({ status: 'ok', value })
      if (value.transactionHash && value.blockNumber !== null && value.gasUsed !== null) {
        setFillTx({
          status: 'confirmed',
          hash: value.transactionHash,
          blockNumber: value.blockNumber,
          gasUsed: value.gasUsed,
        })
      }
      if (value.transactionHash) {
        setReceiptHash(value.transactionHash)
        setRanHere(true)
      }
      void refresh()
      void scanHistory()
      void refreshTaker()
    } catch (error) {
      const message = describeError(error)
      setFill({ status: 'error', message })
      // A dry run signs nothing, so there is no transaction to report as failed. The card below says why.
      if (!dry) setFillTx({ status: 'failed', hash: sent, message })
    }
  }, [fillInputs, refresh, refreshTaker, scanHistory])

  /** `TestERC20.mint` is public, which is what lets a judge drive the demo without asking anyone for tokens. */
  const onMint = useCallback(() => {
    if (!takerAddress || !tokenIn || !walletClient) return
    void mintTx.send(() => mintTo({ wallet: walletClient, token: tokenIn, taker: takerAddress, amount: MINT_AMOUNT }), {
      onConfirmed: () => void refreshTaker(),
    })
  }, [mintTx, refreshTaker, takerAddress, tokenIn, walletClient])

  const onApprove = useCallback(() => {
    if (!takerAddress || !tokenIn || !router || !walletClient) return
    void approveTx.send(() => approveRouter({ wallet: walletClient, token: tokenIn, taker: takerAddress, router }), {
      onConfirmed: () => void refreshTaker(),
    })
  }, [approveTx, refreshTaker, router, takerAddress, tokenIn, walletClient])

  const onClaimFees = useCallback(async () => {
    if (!vaultAddress || !snapshot) return
    if (tokenId === null) {
      setClaim({
        status: 'error',
        message: 'no position yet, so there is no tokenId to claim fees on. The setup script creates it.',
      })
      return
    }
    setClaim({ status: 'pending' })
    executeTx.reset()
    try {
      // No token addresses: `ClaimFeesRequest` does not declare them, the position is named by `tokenId` alone.
      const { payload } = await claimFees({
        chainId,
        walletAddress: vaultAddress,
        tokenId: tokenId.toString(),
      })
      setClaim({ status: 'ok', value: { tx: findTransactionRequest(payload), payload } })
    } catch (error) {
      setClaim({ status: 'error', message: describeError(error) })
    }
  }, [chainId, executeTx, snapshot, tokenId, vaultAddress])

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
      setUnwind({ status: 'error', message: describeError(error) })
    }
  }, [chainId, snapshot, tokenId, vaultAddress])

  const onExecuteClaim = useCallback(() => {
    if (claim.status !== 'ok' || !claim.value.tx || !vaultAddress || !takerAddress || !walletClient) return
    const data = claim.value.tx.data as Hex
    void executeTx.send(
      () =>
        walletClient.writeContract({
          account: takerAddress,
          chain: CHAIN,
          address: vaultAddress,
          abi: vaultAbi,
          functionName: 'executeOnPositionManager',
          args: [data, 0n],
        }),
      { onConfirmed: () => void refresh() },
    )
  }, [claim, executeTx, refresh, takerAddress, vaultAddress, walletClient])

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
    <StatedReasonsProvider value={statedReasons}>
      <div className="wrap dash">
        {/* one state at the top, and it is not the same shape as an error ------ */}
        {readiness.phase === 'loading' ? (
          <div className="banner loading">
            <span className="led pulse" />
            reading Ethereum Sepolia. Nothing on this page is cached, so every field below is waiting on its
            first answer.
          </div>
        ) : null}
        {readiness.phase === 'failed' ? (
          <div className="banner bad">
            the chain state could not be read: {snapshotError}. The fields below are the last thing this page
            knew, or nothing at all.
          </div>
        ) : null}
        {readiness.stated.map((entry) => (
          <div className="banner" key={entry.reason}>
            {entry.reason}
            {entry.fields ? (
              <span className="faint">
                {' '}
                , {entry.fields} field{entry.fields === 1 ? '' : 's'} below are waiting on it
              </span>
            ) : null}
          </div>
        ))}
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
            disabled={fill.status === 'pending' || !fillInputs.ok}
            title={
              fillInputs.ok
                ? 'quote, size, /lp/decrease, /lp/increase, taker traits, swap(). All of it in this tab, signed by the connected wallet'
                : fillInputs.reason
            }
          >
            {fill.status === 'pending' ? 'filling' : dryRun ? 'Run a fill, dry' : 'Run a fill'}
          </button>
          <label className="toggle" title="simulate against live state and broadcast nothing, yarn fill --dry">
            <input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} />
            dry
          </label>
          <button
            className="btn"
            onClick={onMint}
            disabled={mintTx.busy || !takerAddress || !tokenIn || !walletClient || wrongChain}
            title={
              takerAddress
                ? `TestERC20.mint is public, this mints ${fmtAmount(MINT_AMOUNT, inDecimals, 0)} ${inSymbol} to your wallet`
                : 'connect a wallet first, the tokens are minted to it'
            }
          >
            {mintTx.state.status === 'signing'
              ? 'confirm in wallet'
              : mintTx.state.status === 'pending'
                ? 'minting'
                : `Mint ${inSymbol}`}
          </button>
          <button
            className="btn"
            onClick={onApprove}
            disabled={approveTx.busy || !takerAddress || !tokenIn || !router || !walletClient || wrongChain}
            title={
              takerAddress
                ? 'approves the router, not Aqua: useTransferFromAndAquaPush makes the router push on your behalf'
                : 'connect a wallet first'
            }
          >
            {approveTx.state.status === 'signing'
              ? 'confirm in wallet'
              : approveTx.state.status === 'pending'
                ? 'approving'
                : 'Approve the router'}
          </button>
          <button className="btn" onClick={() => void onClaimFees()} disabled={claim.status === 'pending'}>
            Claim fees
          </button>

          <div className="spacer" />
          <label className="toggle">
            <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
            auto refresh, 5 s
          </label>
        </div>

        {fillInputs.ok ? null : (
          <div className="actionbar-note">
            the fill is not armed: {fillInputs.reason}
          </div>
        )}
        {mintTx.state.status !== 'idle' || approveTx.state.status !== 'idle' || fillTx.status !== 'idle' ? (
          <div className="txbar">
            <TxStatus state={fillTx} label="swap()" />
            <TxStatus state={mintTx.state} label="mint" />
            <TxStatus state={approveTx.state} label="approve" />
          </div>
        ) : null}

        {/* the two figures ---------------------------------------------------- */}
        <section className="headline">
          <Figure
            label="settled through this maker"
            note="Swapped events on the router, summed per input token"
            sub={
              volume
                ? `${volume.count} ${volume.count === 1 ? 'fill' : 'fills'}, paid back out: ${volume.out
                    .map((leg) => `${fmtAmount(leg.value, leg.decimals)} ${leg.symbol}`)
                    .join(' , ') || 'nothing yet'}`
                : 'reading the logs'
            }
          >
            {volume && volume.in.length ? (
              volume.in.map((leg) => (
                <div key={leg.token}>
                  <Num>{fmtAmount(leg.value, leg.decimals)}</Num> <Unit>{leg.symbol}</Unit>
                </div>
              ))
            ) : history ? (
              <>
                <span className="unavailable">no fill in the scanned window</span>
                <span className="why">
                  scanned back to block {integer(history.scannedFrom)} over {history.chunks} range
                  {history.chunks === 1 ? '' : 's'}
                </span>
              </>
            ) : (
              <span className="placeholder">····</span>
            )}
          </Figure>

          <Figure
            label="the float that backed it"
            note="balanceOf the vault, both tokens, right now"
            sub={
              snapshot?.vault.floatA.ok && snapshot.vault.floatB.ok
                ? `${fmtAmount(snapshot.vault.floatA.value, decimalsA)} ${symbolA} , ${fmtAmount(snapshot.vault.floatB.value, decimalsB)} ${symbolB}`
                : ''
            }
          >
            <Show result={float}>
              {(value) => (
                <>
                  <Num>{fmtAmount(value)}</Num> <Unit>tokens</Unit>
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
        <Panel
          accent="aqua"
          title="SLAC"
          note="the Shared Liquidity Amplification Coefficient, 1inch's own metric, Aqua whitepaper page 4: total liquidity provisioned across all strategies over the wallet equity backing it"
          foot={
            <p className="prose">
              The second denominator is what the custom instruction measures on chain. reachableFromPosition() is
              the position's liquidity valued at the maker's own conversion factor, capped at maxUnwindPct and cut
              by the haircut, and instruction 0x92 clamps every quote to the free float plus that figure inside
              the VM. The first denominator is the one a wallet balance check would use, which is why it reads as
              amplification that cannot exist: the inventory it is looking for is deployed, not missing.
            </p>
          }
        >
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
        </Panel>

        <div className="results">
          <ResultPanel title="quote" state={quote}>
            {quote.status === 'ok' ? (
              <dl className="kv">
                <dt>amountIn</dt>
                <dd>
                  {exact(quote.value.amountIn, inDecimals)} {inSymbol}
                </dd>
                <dt>amountOut</dt>
                <dd>
                  {exact(quote.value.amountOut, outDecimals)} {outSymbol}
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
          </ResultPanel>

          {fill.status !== 'idle' ? (
            <Panel
              accent={fill.status === 'ok' ? 'ok' : fill.status === 'error' ? 'bad' : 'pending'}
              title="fill"
              meta={<TxStatus state={fillTx} />}
            >
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
                  running in this tab: a quote through a staticcall, two Uniswap API calls, the taker traits built
                  by solver/src/takerTraits.ts, then swap() signed by the connected wallet.
                </div>
              ) : null}
              {fill.status === 'error' ? <div className="failure mono">{fill.message}</div> : null}
              {fill.status === 'ok' ? (
                <dl className="kv">
                  <dt>{fill.value.dry ? 'simulated' : 'transaction'}</dt>
                  <dd>
                    {fill.value.transactionHash ? (
                      <TxLink hash={fill.value.transactionHash} />
                    ) : (
                      <span className="faint">
                        dry run, nothing was broadcast. The same press with the dry box clear sends it.
                      </span>
                    )}
                  </dd>
                  <dt>quoted</dt>
                  <dd>
                    {exact(fill.value.amountIn, inDecimals)} {inSymbol} in, {exact(fill.value.amountOut, outDecimals)}{' '}
                    {outSymbol} out
                  </dd>
                  <dt>unwind</dt>
                  <dd>
                    {fill.value.unwindPercent} percent of the position
                    <span className="unit">rounded up, liquidityPercentageToDecrease is an integer</span>
                  </dd>
                  <dt>signed by</dt>
                  <dd>
                    <Addr value={fill.value.taker} />
                    <span className="unit">
                      the connected wallet is the taker, and the router pulls the input from it
                    </span>
                  </dd>
                  <dt>takerTraits</dt>
                  <dd>
                    {(fill.value.takerTraitsAndData.length - 2) / 2} bytes
                    <span className="unit">
                      22 of header, then the threshold, the /lp/increase payload and the /lp/decrease payload.
                      Built by solver/src/takerTraits.ts, proved against TakerTraitsLib.build in
                      contracts/test/TakerTraits.t.sol
                    </span>
                  </dd>
                </dl>
              ) : null}
              {progress.log.length ? (
                <details style={{ marginTop: 10 }}>
                  <summary className="faint">what the fill worked out, {progress.log.length} lines</summary>
                  <pre className="json">{progress.log.join('\n')}</pre>
                </details>
              ) : null}
            </Panel>
          ) : null}

          <ResultPanel
            title={ranHere ? 'the fill, read back from its receipt' : 'the last fill on this vault, from its receipt'}
            state={receipt}
          >
            {receipt.status === 'ok' ? <FillReceiptView receipt={receipt.value} snapshot={snapshot} /> : null}
          </ResultPanel>

          <ResultPanel title="claim fees, /lp/claim_fees" state={claim}>
            {claim.status === 'ok' ? (
              <>
                <TxRequestView tx={claim.value.tx} expected={positionManager} />
                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    className="btn small"
                    onClick={onExecuteClaim}
                    disabled={!claim.value.tx || !isVaultOwner || executeTx.busy || !walletClient}
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
                </div>
                <TxStatus state={executeTx.state} label="executeOnPositionManager" />
                <details style={{ marginTop: 10 }}>
                  <summary className="faint">raw response</summary>
                  <pre className="json">{stringify(claim.value.payload)}</pre>
                </details>
              </>
            ) : null}
          </ResultPanel>

          <ResultPanel title="unwind calldata, /lp/decrease" state={unwind}>
            {unwind.status === 'ok' ? (
              <>
                <p className="muted" style={{ marginBottom: 8 }}>
                  This is the payload that goes verbatim into the preTransferOutHookData slice of the taker traits
                  and is executed by the vault one instruction before the tokens leave.
                </p>
                <TxRequestView tx={unwind.value.tx} expected={positionManager} />
              </>
            ) : null}
          </ResultPanel>
        </div>

        <div className="columns">
          <Panel
            accent="uniswap"
            title="Uniswap v4 position"
            meta={
              positionManager ? <Addr value={positionManager} /> : <Missing reason="no position manager address" />
            }
            foot={
              <div className="row">
                <button className="btn small" onClick={() => void onUnwindCalldata()} disabled={unwind.status === 'pending'}>
                  Build unwind calldata
                </button>
                <span className="faint">calls /lp/decrease for real</span>
              </div>
            }
          >
            <Field label="tokenId" note={snapshot?.uniswap.tokenIdSource ?? undefined} size="lead">
              {tokenId === null ? (
                <Missing reason="the position does not exist yet, the setup script creates it through the Uniswap API and hands it to the vault" />
              ) : (
                <Num>{tokenId.toString()}</Num>
              )}
            </Field>
            <Field label="live liquidity" note="getPositionLiquidity(uint256), 0x1efeed33" size="lead">
              <Show result={snapshot?.uniswap.liquidity ?? notRead}>
                {(value) => <Num title={`${value.toString()} raw`}>{liquidityText(value)}</Num>}
              </Show>
            </Field>
            {/* Ticks and fee tiers are parameters, not quantities, so they keep their digits ungrouped. */}
            <Field label="current tick" note="StateView.getSlot0">
              <Show result={snapshot?.uniswap.tick ?? notRead}>{(value) => <Num>{value}</Num>}</Show>
            </Field>
            <Field label="tick bounds" note="getPoolAndPositionInfo, the position's own range">
              {snapshot?.uniswap.tickLower.ok && snapshot.uniswap.tickUpper.ok ? (
                <>
                  <Num>
                    {snapshot.uniswap.tickLower.value} to {snapshot.uniswap.tickUpper.value}
                  </Num>
                  <Unit>
                    {snapshot.uniswap.tickLower.value <= -887220 && snapshot.uniswap.tickUpper.value >= 887220
                      ? 'full range'
                      : 'bounded'}
                  </Unit>
                </>
              ) : (
                <Show result={snapshot?.uniswap.tickLower ?? notRead}>{(value) => <Num>{value}</Num>}</Show>
              )}
            </Field>
            <Field label="fee tier" note="the pool key the position was opened on">
              {snapshot ? (
                <>
                  <Num>{snapshot.vault.keyUsed.fee}</Num>
                  <Unit>
                    {(snapshot.vault.keyUsed.fee / 10_000).toFixed(2)} percent, spacing{' '}
                    {snapshot.vault.keyUsed.tickSpacing}
                  </Unit>
                </>
              ) : (
                <Missing reason={NOT_READ_YET} />
              )}
            </Field>
            <Field label="lp fee, live" note="StateView.getSlot0, hundredths of a bip">
              <Show result={snapshot?.uniswap.lpFee ?? notRead}>{(value) => <Num>{value}</Num>}</Show>
            </Field>
            <Field label="pool liquidity" note="StateView.getLiquidity">
              <Show result={snapshot?.uniswap.poolLiquidity ?? notRead}>
                {(value) => <Num title={`${value.toString()} raw`}>{liquidityText(value)}</Num>}
              </Show>
            </Field>
            <Field label="hook" note="no hook on this pool, the maker is not one">
              {snapshot ? <Addr value={snapshot.vault.keyUsed.hooks} /> : <Missing reason={NOT_READ_YET} />}
            </Field>
            <Field label="position owner">
              <Show result={snapshot?.uniswap.positionOwner ?? notRead}>
                {(value) => (
                  <>
                    <Addr value={value} />
                    {vaultAddress && value.toLowerCase() === vaultAddress.toLowerCase() ? (
                      <Unit>the vault</Unit>
                    ) : null}
                  </>
                )}
              </Show>
            </Field>
            <Field label="poolId">
              {snapshot?.uniswap.poolId ? (
                <Num title={snapshot.uniswap.poolId}>{shortHash(snapshot.uniswap.poolId)}</Num>
              ) : (
                <Missing reason="derived from the position pool key, which needs a live position" />
              )}
            </Field>

            <Subhead>the same pool, as the Uniswap API reports it</Subhead>
            {apiPool ? (
              <>
                <Field label="current tick" note="POST /lp/pool_info">
                  <Num>{String(apiPool.currentTick)}</Num>
                </Field>
                <Field label="pool liquidity" note="POST /lp/pool_info">
                  <Num>{integer(BigInt(String(apiPool.poolLiquidity ?? 0)))}</Num>
                </Field>
                <Field label="token reserves" note="token0 and token1, from the API">
                  <Num>
                    {fmtAmount(BigInt(String(apiPool.token0Reserves ?? 0)), decimalsA)} /{' '}
                    {fmtAmount(BigInt(String(apiPool.token1Reserves ?? 0)), decimalsB)}
                  </Num>
                </Field>
              </>
            ) : (
              <div className="empty">
                Press Refresh state to ask /lp/pool_info about this pool. The request and the response land in the
                panel at the bottom. It is never called on a timer: the key allows six requests a second.
              </div>
            )}
          </Panel>

          <Panel
            accent="vault"
            title="BebecitaVault, the maker"
            meta={vaultAddress ? <Addr value={vaultAddress} /> : <Missing reason="no vault address" />}
          >
            <Field label={`free float, ${symbolA}`} note="balanceOf the vault" size="lead">
              <Show result={snapshot?.vault.floatA ?? notRead}>
                {(value) => <Num>{fmtAmount(value, decimalsA)}</Num>}
              </Show>
            </Field>
            <Field label={`free float, ${symbolB}`} note="balanceOf the vault" size="lead">
              <Show result={snapshot?.vault.floatB ?? notRead}>
                {(value) => <Num>{fmtAmount(value, decimalsB)}</Num>}
              </Show>
            </Field>

            <Subhead>URC-3, hook TVL and effective liquidity reporting</Subhead>
            <Field
              label="reserves"
              note={
                snapshot
                  ? `getReserves(PoolKey), ${tokenOf(snapshot, snapshot.vault.keyUsed.currency0).symbol} and ${tokenOf(snapshot, snapshot.vault.keyUsed.currency1).symbol}`
                  : 'getReserves(PoolKey)'
              }
            >
              <Show result={snapshot?.vault.reserves ?? notRead}>
                {([first, second]) => (
                  <Num>
                    {fmtAmount(first, snapshot ? tokenOf(snapshot, snapshot.vault.keyUsed.currency0).decimals : 18)}
                    {' / '}
                    {fmtAmount(second, snapshot ? tokenOf(snapshot, snapshot.vault.keyUsed.currency1).decimals : 18)}
                  </Num>
                )}
              </Show>
            </Field>
            <Field label="effective liquidity" note="getEffectiveLiquidity(PoolKey), what one fill can reach">
              <Show result={snapshot?.vault.effectiveLiquidity ?? notRead}>
                {([first, second]) => (
                  <Num>
                    {fmtAmount(first, snapshot ? tokenOf(snapshot, snapshot.vault.keyUsed.currency0).decimals : 18)}
                    {' / '}
                    {fmtAmount(second, snapshot ? tokenOf(snapshot, snapshot.vault.keyUsed.currency1).decimals : 18)}
                  </Num>
                )}
              </Show>
            </Field>
            <Field label="invariant" note="effective liquidity must not exceed reserves">
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
                <Missing reason={NOT_READ_YET} />
              )}
            </Field>

            <Subhead>what one fill may lean on</Subhead>
            <Field label="reachableFromPosition" note="the figure instruction 0x92 clamps to" size="lead">
              <Show result={snapshot?.vault.reachable ?? notRead}>
                {(value) => <Num>{fmtAmount(value, decimalsB)}</Num>}
              </Show>
            </Field>
            <Field label="maxUnwindPct" note="largest share of the position one fill may unwind">
              <Show result={snapshot?.vault.maxUnwindPct ?? notRead}>
                {(value) => (
                  <>
                    <Num>{integer(value)}</Num>
                    <Unit>percent</Unit>
                  </>
                )}
              </Show>
            </Field>
            <Field label="haircutBps" note="safety margin on the deployed leg">
              <Show result={snapshot?.vault.haircutBps ?? notRead}>
                {(value) => (
                  <>
                    <Num>{integer(value)}</Num>
                    <Unit>bps</Unit>
                  </>
                )}
              </Show>
            </Field>
            <Field label="unitsPerLiquidityE18" note="tokenOut units per unit of position liquidity">
              <Show result={snapshot?.vault.unitsPerLiquidityE18 ?? notRead}>
                {(value) => <Num>{integer(value)}</Num>}
              </Show>
            </Field>
            <Field label="pool key used" note={snapshot?.vault.keyFromPosition ? 'read from the position' : undefined}>
              {snapshot ? (
                snapshot.vault.keyFromPosition ? (
                  <Num>
                    fee {snapshot.vault.keyUsed.fee}, spacing {snapshot.vault.keyUsed.tickSpacing}
                  </Num>
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
                <Missing reason={NOT_READ_YET} />
              )}
            </Field>
            <Field label="owner">
              <Show result={snapshot?.vault.owner ?? notRead}>
                {(value) => (
                  <>
                    <Addr value={value} />
                    {isVaultOwner ? <Unit>your wallet</Unit> : null}
                  </>
                )}
              </Show>
            </Field>
          </Panel>

          <Panel
            accent="aqua"
            title="Aqua, official"
            meta={<Show result={snapshot?.aqua.address ?? notRead}>{(value) => <Addr value={value} />}</Show>}
          >
            <Field label="router AQUA()" note="the one line that proves the official contract does the work">
              <Show result={snapshot?.aqua.routerAqua ?? notRead}>
                {(value) => (
                  <>
                    <Addr value={value} />
                    {snapshot?.aqua.address.ok && value.toLowerCase() === snapshot.aqua.address.value.toLowerCase() ? (
                      <Unit>matches the vault</Unit>
                    ) : null}
                  </>
                )}
              </Show>
            </Field>
            <Field label="custom opcode" note="OPCODE_UNWIND_PRICED_BALANCE_OUT()">
              <Show result={snapshot?.aqua.opcode ?? notRead}>
                {(value) => (
                  <>
                    <Num>{value.toString()}</Num>
                    <Unit>0x{value.toString(16)}</Unit>
                  </>
                )}
              </Show>
            </Field>
            <Field label="app" note="the router the strategies were shipped to">
              {snapshot?.aqua.app ? <Addr value={snapshot.aqua.app} /> : <Missing reason={NOT_READ_YET} />}
            </Field>

            <Subhead
              note={
                history
                  ? `Shipped events on the vault, blocks ${integer(history.scannedFrom)} to ${integer(history.head)}. Balances are rawBalances(maker, app, strategyHash, token) on Aqua`
                  : 'balances are rawBalances(maker, app, strategyHash, token) on Aqua'
              }
            >
              every strategy this vault has shipped
              {snapshot?.aqua.strategies.length ? ` , ${snapshot.aqua.strategies.length}` : ''}
            </Subhead>
            {historyError ? (
              <div className="empty">
                <span className="unavailable">the log scan stopped early</span>
                <span className="why">{historyError}</span>
              </div>
            ) : null}
            {snapshot?.aqua.strategies.length ? (
              <div className="strategies">
              {snapshot.aqua.strategies.map((strategy) => {
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
                        {shortHash(strategy.hash)}
                      </span>
                      {isLive ? <span className="chip">quoting now</span> : null}
                      {docked ? <span className="chip warn">docked</span> : null}
                    </div>
                    <div className="strategy-meta">
                      {meta ? (
                        <>
                          block {integer(meta.blockNumber)},{' '}
                          <TxLink hash={meta.txHash} />
                          {meta.fills
                            ? ` , ${meta.fills} ${meta.fills === 1 ? 'fill' : 'fills'} settled`
                            : ' , no fill settled on it'}
                        </>
                      ) : (
                        <>named by deployments/sepolia.json, shipped outside the scanned log window</>
                      )}
                    </div>
                    {strategy.balances.map((balance) => (
                      <Field key={balance.token} label={balance.symbol}>
                        <Show result={balance.raw}>
                          {(value) => (
                            <>
                              <Num>
                                {fmtAmount(
                                  value.balance,
                                  balance.token.toLowerCase() === snapshot.tokenA.address.toLowerCase()
                                    ? decimalsA
                                    : decimalsB,
                                )}
                              </Num>
                              <Unit>tokensCount {value.tokensCount}</Unit>
                            </>
                          )}
                        </Show>
                      </Field>
                    ))}
                    <div className="strategy-total">
                      <span>provisioned</span>
                      <span>
                        <span className="num">{fmtAmount(subtotal, 18, 0)}</span> tokens
                      </span>
                    </div>
                  </div>
                )
              })}
              </div>
            ) : (
              <div className="empty">
                No strategy found. The vault emits Shipped when it opens one, and this column reads the balances
                straight out of the official Aqua under that hash.
              </div>
            )}

            <Subhead
              note={
                takerAddress
                  ? 'the connected wallet, which signs the swap. There is no process between this page and the chain'
                  : NO_WALLET
              }
            >
              the taker
            </Subhead>
            <Field label="address" note="whoever presses the button">
              {takerAddress ? (
                <>
                  <Addr value={takerAddress} />
                  {wrongChain ? <Unit>on chain {walletChainId}, not Sepolia</Unit> : null}
                </>
              ) : (
                <Missing reason={NO_WALLET} />
              )}
            </Field>
            <Field label={`balance, ${inSymbol}`} note="what the router will pull from you">
              {taker ? (
                <Num>{fmtAmount(taker.balance, inDecimals)}</Num>
              ) : (
                <Missing reason={takerAddress ? 'the balance has not been read yet' : NO_WALLET} />
              )}
            </Field>
            <Field label="allowance to the router" note="not to Aqua, the router pushes on your behalf">
              {taker ? (
                taker.allowance > 2n ** 200n ? (
                  <>
                    <Num>unlimited</Num>
                    <Unit>approved</Unit>
                  </>
                ) : (
                  <Num>{fmtAmount(taker.allowance, inDecimals)}</Num>
                )
              ) : (
                <Missing reason={takerAddress ? 'the allowance has not been read yet' : NO_WALLET} />
              )}
            </Field>
            {router ? (
              <Field label="router">
                <Addr value={router} />
              </Field>
            ) : null}
          </Panel>
        </div>

        <NetworkPanel />
      </div>
    </StatedReasonsProvider>
  )
}
