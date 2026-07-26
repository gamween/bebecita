import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
import { approveRouter, mintTo, readTakerPosition, runFill, type FillResult } from '../lib/fill'
import { amount as fmtAmount, exact, integer, reason, shortAddress, type Result } from '../lib/format'
import { lastRateLimitRemaining, netlog } from '../lib/netlog'
import { orderFrom, requestQuote, type QuoteResult } from '../lib/quote'
import { NOT_READ_YET, readinessOf } from '../lib/readiness'
import { readSnapshot, tokenOf, type Snapshot } from '../lib/state'
import { txIdle, useTx, type TxState } from '../lib/tx'
import { claimFees, findTransactionRequest, poolInfo, type TransactionRequest } from '../lib/uniswap'

const MINT_AMOUNT = 10_000n * 10n ** 18n
const STATE_POLL_MS = 5_000
/** The Uniswap key allows six requests a second. One pool_info per press of Refresh, never on the timer. */
const POOL_INFO_MIN_GAP_MS = 15_000

/**
 * The canonical Aqua, as `solver/src/config.ts` and README.md name it.
 *
 * It is written down here so the address the router returns can be compared against something on screen. The
 * value that carries the proof is the one read from the deployed router, not this string.
 */
const CANONICAL_AQUA = '0x499943E74FB0cE105688beeE8Ef2ABec5D936d31'

const notRead: Result<never> = { ok: false, reason: NOT_READ_YET }

/** Position liquidity is a 1e18 scaled quantity, so it reads as a number rather than as a 24 digit integer. */
const liquidityText = (value: bigint) => fmtAmount(value < 0n ? -value : value, 18)

type Action<T> =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string }

const idle = { status: 'idle' } as const

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
      {state.status === 'pending' ? <div className="muted">Waiting on the network…</div> : null}
      {state.status === 'error' ? <div className="failure mono">{state.message}</div> : null}
      {state.status === 'ok' ? children : null}
    </Panel>
  )
}

export function Dashboard({ config }: { config: AppConfig | null }) {
  const { address, chainId: walletChainId, status: walletStatus } = useConnection()
  const { data: walletClient } = useWalletClient()
  const takerAddress = (walletStatus === 'connected' ? (address as Address | undefined) : undefined) ?? null
  const wrongChain = walletStatus === 'connected' && walletChainId !== CHAIN.id

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [amountInput, setAmountInput] = useState('1000')
  const [aToB, setAToB] = useState(true)
  const [dryRun, setDryRun] = useState(false)

  const [quote, setQuote] = useState<Action<QuoteResult>>(idle)
  const [fill, setFill] = useState<Action<FillResult>>(idle)
  const [fillTx, setFillTx] = useState<TxState>(txIdle)
  const [claim, setClaim] = useState<Action<{ tx: TransactionRequest }>>(idle)
  const [taker, setTaker] = useState<{ balance: bigint; allowance: bigint } | null>(null)

  const mintTx = useTx()
  const approveTx = useTx()
  const executeTx = useTx()

  const chainId = config?.deployment.chainId ?? config?.chain.chainId ?? CHAIN.id
  const poolInfoAt = useRef(0)

  /**
   * Reads the chain, and on a press also asks the Uniswap API about the pool.
   *
   * `pressed` separates the two callers. The poll runs silently, because a snapshot is four sequential round
   * trips against a public endpoint and driving the button's own spinner from the timer left it disabled for
   * most of every interval, which made the one control that generates API traffic almost unclickable.
   */
  const refresh = useCallback(
    async (options: { pressed?: boolean } = {}) => {
      if (!config) return
      if (options.pressed) setRefreshing(true)
      try {
        const next = await readSnapshot(config, [])
        setSnapshot(next)
        setSnapshotError(null)
        // A press also puts a real authenticated request and its response in the panel at the bottom, with no
        // wallet and no gas. The poll never does: the key allows six requests a second and a demo should not
        // spend that on a timer.
        if (options.pressed && Date.now() - poolInfoAt.current > POOL_INFO_MIN_GAP_MS) {
          poolInfoAt.current = Date.now()
          const key = next.vault.keyUsed
          // A failure is already recorded whole in the network log, which is where it belongs and where it reads.
          await poolInfo({
            chainId,
            tokenA: key.currency0,
            tokenB: key.currency1,
            fee: key.fee,
            tickSpacing: key.tickSpacing,
            hooks: key.hooks,
          }).catch(() => null)
        }
      } catch (error) {
        setSnapshotError(reason(error))
      } finally {
        if (options.pressed) setRefreshing(false)
      }
    },
    [chainId, config],
  )

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), STATE_POLL_MS)
    return () => clearInterval(interval)
  }, [refresh])

  const token0 = snapshot?.vault.keyUsed.currency0 ?? null
  const token1 = snapshot?.vault.keyUsed.currency1 ?? null
  const metaOf = (token: Address | null) =>
    snapshot && token ? tokenOf(snapshot, token) : { symbol: 'token', decimals: 18 }
  const symbol0 = token0 ? metaOf(token0).symbol : 'token0'
  const symbol1 = token1 ? metaOf(token1).symbol : 'token1'
  const decimals0 = metaOf(token0).decimals
  const decimals1 = metaOf(token1).decimals
  // The vault's two floats are keyed by the deployment's token A and token B, which is not the pool's sorted
  // order, so they carry their own labels rather than borrowing the two above.
  const symbolA = snapshot?.tokenA.symbol.ok ? snapshot.tokenA.symbol.value : 'token A'
  const symbolB = snapshot?.tokenB.symbol.ok ? snapshot.tokenB.symbol.value : 'token B'
  const decimalsA = snapshot?.tokenA.decimals.ok ? snapshot.tokenA.decimals.value : 18
  const decimalsB = snapshot?.tokenB.decimals.ok ? snapshot.tokenB.decimals.value : 18
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

  const mintReset = mintTx.reset
  const approveReset = approveTx.reset
  const executeReset = executeTx.reset
  useEffect(() => {
    mintReset()
    approveReset()
    executeReset()
    setFillTx(txIdle)
    setClaim(idle)
  }, [approveReset, executeReset, mintReset, takerAddress])

  const readiness = useMemo(() => readinessOf(snapshot, snapshotError), [snapshot, snapshotError])

  const netEntries = useSyncExternalStore(netlog.subscribe, netlog.snapshot)
  const netRemaining = lastRateLimitRemaining(netEntries)
  const [netOpen, setNetOpen] = useState(false)
  // Opened once, on the first call, and left under the visitor's control after that. A panel that reopened on
  // every request would fight whoever had just closed it.
  const netOpenedOnce = useRef(false)
  useEffect(() => {
    if (!netEntries.length || netOpenedOnce.current) return
    netOpenedOnce.current = true
    setNetOpen(true)
  }, [netEntries.length])

  const parsedAmount = useMemo(() => {
    try {
      return parseUnits(amountInput || '0', inDecimals)
    } catch {
      return null
    }
  }, [amountInput, inDecimals])

  const hasBalance = Boolean(taker && parsedAmount !== null && parsedAmount > 0n && taker.balance >= parsedAmount)
  const hasAllowance = Boolean(taker && parsedAmount !== null && parsedAmount > 0n && taker.allowance >= parsedAmount)
  const isVaultOwner =
    takerAddress && snapshot?.vault.owner.ok
      ? takerAddress.toLowerCase() === snapshot.vault.owner.value.toLowerCase()
      : false

  const onQuote = useCallback(async () => {
    if (!config?.deployment.router || !orderResult) return
    if (!orderResult.ok) {
      setQuote({ status: 'error', message: orderResult.reason })
      return
    }
    if (parsedAmount === null || parsedAmount <= 0n) {
      setQuote({ status: 'error', message: 'Enter a valid amount.' })
      return
    }
    setQuote({ status: 'pending' })
    try {
      setQuote({
        status: 'ok',
        value: await requestQuote({
          router: config.deployment.router,
          order: orderResult.value,
          amount: parsedAmount,
          isExactIn: true,
          isAToB: aToB,
        }),
      })
    } catch (error) {
      setQuote({ status: 'error', message: describeError(error) })
    }
  }, [aToB, config, orderResult, parsedAmount])

  const fillInputs = useMemo(():
    | { ok: true; value: Omit<Parameters<typeof runFill>[0], 'onEvent'> }
    | { ok: false; reason: string } => {
    if (!config || !snapshot) return { ok: false, reason: 'Chain state is still loading.' }
    if (!takerAddress) return { ok: false, reason: 'Connect a wallet to continue.' }
    if (wrongChain) return { ok: false, reason: 'Switch your wallet to Ethereum Sepolia.' }
    if (!walletClient) return { ok: false, reason: 'Wallet is not ready yet.' }
    if (parsedAmount === null || parsedAmount <= 0n) return { ok: false, reason: 'Enter a valid amount.' }
    if (!orderResult) return { ok: false, reason: 'Deployment is not ready.' }
    if (!orderResult.ok) return { ok: false, reason: orderResult.reason }
    if (!router || !vaultAddress || !positionManager) return { ok: false, reason: 'Deployment is incomplete.' }
    if (tokenId === null) return { ok: false, reason: 'LP position is not ready.' }
    if (!token0 || !token1) return { ok: false, reason: 'Pool state is not ready.' }
    if (!snapshot.vault.unitsPerLiquidityE18.ok) return { ok: false, reason: 'Liquidity data is unavailable.' }
    if (!snapshot.vault.maxUnwindPct.ok) return { ok: false, reason: 'Position limit is unavailable.' }
    if (!snapshot.vault.haircutBps.ok) return { ok: false, reason: 'Safety margin is unavailable.' }

    return {
      ok: true,
      value: {
        amount: parsedAmount,
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
    chainId,
    config,
    dryRun,
    orderResult,
    parsedAmount,
    positionManager,
    router,
    snapshot,
    takerAddress,
    token0,
    token1,
    tokenId,
    vaultAddress,
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
    let sent: Hex | null = null

    try {
      const value = await runFill({
        ...fillInputs.value,
        onEvent: (event) => {
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
      void refresh()
      void refreshTaker()
    } catch (error) {
      const message = describeError(error)
      setFill({ status: 'error', message })
      if (!dry) setFillTx({ status: 'failed', hash: sent, message })
    }
  }, [fillInputs, refresh, refreshTaker])

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
    if (!vaultAddress || !snapshot) {
      setClaim({ status: 'error', message: 'The LP position is not ready yet.' })
      return
    }
    if (tokenId === null) {
      setClaim({ status: 'error', message: 'No LP position is available to claim.' })
      return
    }
    setClaim({ status: 'pending' })
    executeTx.reset()
    try {
      const { payload } = await claimFees({
        chainId,
        walletAddress: vaultAddress,
        tokenId: tokenId.toString(),
      })
      const tx = findTransactionRequest(payload)
      if (!tx) throw new Error('The fee claim API did not return an executable transaction.')
      setClaim({ status: 'ok', value: { tx } })
    } catch (error) {
      setClaim({ status: 'error', message: describeError(error) })
    }
  }, [chainId, executeTx, snapshot, tokenId, vaultAddress])

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
    ? 'Addresses are still loading.'
    : parsedAmount === null || parsedAmount <= 0n
      ? 'Enter a valid amount.'
      : orderResult && !orderResult.ok
        ? orderResult.reason
        : null

  return (
    <StatedReasonsProvider value={readiness.statedSet}>
      <div className="wrap dash client-console">
        <header className="dashboard-intro">
          <h1 tabIndex={-1}>Live settlement</h1>
          <div className="dashboard-intro-meta">
            <span className="console-state">
              <span
                className={
                  readiness.phase === 'ready'
                    ? 'led'
                    : readiness.phase === 'degraded'
                      ? 'led warn'
                      : readiness.phase === 'failed'
                        ? 'led bad'
                        : 'led pulse'
                }
              />
              {readiness.phase === 'ready'
                ? 'Ready'
                : readiness.phase === 'degraded'
                  ? 'Partly read'
                  : readiness.phase === 'failed'
                    ? 'Connection failed'
                    : 'Connecting'}
            </span>
          </div>
        </header>

        <div className="readiness-stack" aria-live="polite">
          {readiness.phase === 'failed' ? <div className="banner bad">{snapshotError}</div> : null}
          {readiness.phase === 'degraded' ? (
            <div className="banner">
              Sepolia answered, but {readiness.broken.length} of the reads this page leads with did not:{' '}
              {readiness.broken.map((entry) => entry.what).join(', ')}. The reason sits on each field below.
            </div>
          ) : null}
          {readiness.stated.map((entry) => (
            <div className="banner" key={entry.reason}>
              {entry.reason}
              {entry.fields ? (
                <span className="faint">
                  , {entry.fields} field{entry.fields === 1 ? '' : 's'} below are waiting on it
                </span>
              ) : null}
            </div>
          ))}
          {config?.problems.length ? <div className="banner bad">{config.problems.join(' · ')}</div> : null}
        </div>

        {/*
         * The live strip. Four figures out of the poll that was already running, so the page visibly moves while
         * nobody touches it, which is the acceptance criterion for this screen in docs/PLAN.md.
         */}
        {/* Not aria-live: these four change every five seconds and announcing each one would talk over the page. */}
        <div className="livestrip" aria-label="Live chain state">
          <div className="livestrip-cell">
            <span className="livestrip-label">block</span>
            <span className="livestrip-value">
              <Show result={snapshot?.blockNumber ?? notRead}>{(value) => integer(value)}</Show>
            </span>
          </div>
          <div className="livestrip-cell">
            <span className="livestrip-label">pool tick</span>
            <span className="livestrip-value">
              <Show result={snapshot?.uniswap.tick ?? notRead}>
                {(value) => (
                  <>
                    {value}
                    <Unit>StateView.getSlot0</Unit>
                  </>
                )}
              </Show>
            </span>
          </div>
          <div className="livestrip-cell">
            <span className="livestrip-label">position liquidity</span>
            <span className="livestrip-value">
              <Show result={snapshot?.uniswap.liquidity ?? notRead}>
                {(value) => (
                  <>
                    <span title={`${value.toString()} raw`}>{liquidityText(value)}</span>
                    <Unit>getPositionLiquidity</Unit>
                  </>
                )}
              </Show>
            </span>
          </div>
          <div className="livestrip-cell">
            <span className="livestrip-label">tokenId</span>
            <span className="livestrip-value">
              {!snapshot ? (
                <Missing reason={NOT_READ_YET} />
              ) : tokenId === null ? (
                <Missing reason="the position does not exist yet, the setup script creates it through the Uniswap API and hands it to the vault" />
              ) : (
                <>
                  {tokenId.toString()}
                  {snapshot?.uniswap.tokenIdSource ? <Unit>{snapshot.uniswap.tokenIdSource}</Unit> : null}
                </>
              )}
            </span>
          </div>
        </div>

        <section className="trade-card" aria-labelledby="trade-title">
          <div className="trade-card-head">
            <h2 id="trade-title">Swap tokens</h2>
            <span className="trade-pair">
              {symbol0} / {symbol1}
            </span>
          </div>

          <div className="trade-grid">
            <div className="trade-order">
              <div className="trade-fields">
                <div>
                  <label className="field-label" htmlFor="amount">
                    You pay · {inSymbol}
                  </label>
                  <input
                    id="amount"
                    className="input amount-input"
                    value={amountInput}
                    onChange={(event) => setAmountInput(event.target.value)}
                    inputMode="decimal"
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="direction">
                    Direction
                  </label>
                  <select
                    id="direction"
                    className="select direction-select"
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
              </div>

              <div className="trade-execution">
                <button
                  className="btn"
                  onClick={() => void onQuote()}
                  disabled={quote.status === 'pending' || Boolean(quoteDisabledReason)}
                  title={quoteDisabledReason ?? 'Get the current quote.'}
                >
                  {quote.status === 'pending' ? 'Quoting…' : 'Get quote'}
                </button>
                <button
                  className="btn primary"
                  onClick={() => void onFill()}
                  disabled={fill.status === 'pending' || !fillInputs.ok}
                  title={fillInputs.ok ? 'Execute with your connected wallet.' : fillInputs.reason}
                >
                  {fill.status === 'pending' ? 'Executing…' : dryRun ? 'Simulate' : 'Swap'}
                </button>
                <label className="toggle" title="Preview the fill without broadcasting a transaction.">
                  <input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} />
                  Simulate only
                </label>
              </div>
            </div>

            <aside className="trade-setup" aria-label="Wallet setup">
              <div className="trade-setup-head">
                <span>Wallet</span>
                <span>{takerAddress ? shortAddress(takerAddress) : 'Not connected'}</span>
              </div>

              <div className="wallet-readiness" aria-live="polite">
                <span>{taker ? `${fmtAmount(taker.balance, inDecimals)} ${inSymbol}` : 'Balance not read'}</span>
                {taker && parsedAmount !== null && parsedAmount > 0n ? (
                  <>
                    <span className={hasBalance ? 'ready' : 'needs-action'}>
                      {hasBalance ? 'Balance ready' : 'Top up required'}
                    </span>
                    <span className={hasAllowance ? 'ready' : 'needs-action'}>
                      {hasAllowance ? 'Approved' : 'Approval required'}
                    </span>
                  </>
                ) : null}
              </div>

              <div className="trade-setup-actions">
                <button
                  className="btn"
                  onClick={onMint}
                  disabled={mintTx.busy || !takerAddress || !tokenIn || !walletClient || wrongChain}
                  title={takerAddress ? `Mint demo ${inSymbol}.` : 'Connect a wallet first.'}
                >
                  <span className="button-step">1</span>
                  {mintTx.state.status === 'signing'
                    ? 'Confirm in wallet'
                    : mintTx.state.status === 'pending'
                      ? 'Minting…'
                      : `Mint ${inSymbol}`}
                </button>
                <button
                  className="btn"
                  onClick={onApprove}
                  disabled={approveTx.busy || !takerAddress || !tokenIn || !router || !walletClient || wrongChain}
                  title={takerAddress ? 'Approve the router for this token.' : 'Connect a wallet first.'}
                >
                  <span className="button-step">2</span>
                  {approveTx.state.status === 'signing'
                    ? 'Confirm in wallet'
                    : approveTx.state.status === 'pending'
                      ? 'Approving…'
                      : 'Approve'}
                </button>
              </div>
            </aside>
          </div>

          <div className="trade-card-foot">
            <button
              className="btn small ghost"
              onClick={() => void refresh({ pressed: true })}
              disabled={refreshing || !config}
              title="Read the chain again, and ask the Uniswap API about this pool. No wallet and no gas."
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            {isVaultOwner && tokenId !== null ? (
              <button
                className="btn small ghost"
                onClick={() => void onClaimFees()}
                disabled={claim.status === 'pending'}
              >
                Claim LP fees
              </button>
            ) : null}
          </div>
        </section>

        {fillInputs.ok ? null : <div className="actionbar-note">{fillInputs.reason}</div>}

        {mintTx.state.status !== 'idle' || approveTx.state.status !== 'idle' || fillTx.status !== 'idle' ? (
          <div className="txbar" aria-live="polite">
            <TxStatus state={fillTx} label="swap" />
            <TxStatus state={mintTx.state} label="mint" />
            <TxStatus state={approveTx.state} label="approve" />
          </div>
        ) : null}

        <section className="client-results" aria-label="Swap result" aria-live="polite">
          <ResultPanel title="Quote" state={quote}>
            {quote.status === 'ok' ? (
              <div className="client-swap-summary">
                <div className="client-swap-leg">
                  <span>You pay</span>
                  <strong>
                    {exact(quote.value.amountIn, inDecimals)} {inSymbol}
                  </strong>
                </div>
                <span className="client-swap-arrow" aria-hidden="true">
                  →
                </span>
                <div className="client-swap-leg">
                  <span>You receive</span>
                  <strong>
                    {exact(quote.value.amountOut, outDecimals)} {outSymbol}
                  </strong>
                </div>
              </div>
            ) : null}
          </ResultPanel>

          {fill.status !== 'idle' ? (
            <Panel
              accent={fill.status === 'ok' ? 'ok' : fill.status === 'error' ? 'bad' : 'pending'}
              title="Swap"
              meta={<TxStatus state={fillTx} />}
            >
              {fill.status === 'pending' ? <div className="muted">Preparing your transaction…</div> : null}
              {fill.status === 'error' ? <div className="failure mono">{fill.message}</div> : null}
              {fill.status === 'ok' ? (
                <>
                  <div className="client-swap-summary">
                    <div className="client-swap-leg">
                      <span>Paid</span>
                      <strong>
                        {exact(fill.value.amountIn, inDecimals)} {inSymbol}
                      </strong>
                    </div>
                    <span className="client-swap-arrow" aria-hidden="true">
                      →
                    </span>
                    <div className="client-swap-leg">
                      <span>Received</span>
                      <strong>
                        {exact(fill.value.amountOut, outDecimals)} {outSymbol}
                      </strong>
                    </div>
                  </div>
                  <div className="client-result-link">
                    {fill.value.transactionHash ? (
                      <TxLink hash={fill.value.transactionHash} />
                    ) : (
                      <span>Simulation completed. Nothing was broadcast.</span>
                    )}
                  </div>
                </>
              ) : null}
            </Panel>
          ) : null}

          {isVaultOwner ? (
            <ResultPanel title="LP fees" state={claim}>
              {claim.status === 'ok' ? (
                <div className="claim-ready">
                  <button
                    className="btn primary small"
                    onClick={onExecuteClaim}
                    disabled={executeTx.busy || !walletClient}
                  >
                    Confirm fee claim
                  </button>
                  <TxStatus state={executeTx.state} label="claim" />
                </div>
              ) : null}
            </ResultPanel>
          ) : null}
        </section>

        <section className="evidence" aria-label="Maker state">
          <Panel
            accent="vault"
            title="BebecitaVault, the maker"
            meta={vaultAddress ? <Addr value={vaultAddress} /> : <Missing reason="no vault address" />}
            note="URC-3 asks a hook two different questions: everything it holds, and what a single interaction can actually reach. The gap between the two answers is the cost of getting out of the position, and pricing it is what instruction 0x92 exists for."
          >
            <Subhead>URC-3, hook TVL and effective liquidity reporting</Subhead>
            <Field label="getReserves" note={`${symbol0} and ${symbol1}, everything the maker holds`} size="lead">
              <Show result={snapshot?.vault.reserves ?? notRead}>
                {([first, second]) => (
                  <Num>
                    {fmtAmount(first, decimals0)} / {fmtAmount(second, decimals1)}
                  </Num>
                )}
              </Show>
            </Field>
            <Field label="getEffectiveLiquidity" note="the same two currencies, what one fill can reach" size="lead">
              <Show result={snapshot?.vault.effectiveLiquidity ?? notRead}>
                {([first, second]) => (
                  <Num>
                    {fmtAmount(first, decimals0)} / {fmtAmount(second, decimals1)}
                  </Num>
                )}
              </Show>
            </Field>
            <Field label="invariant" note="effective liquidity must not exceed reserves, on either side">
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
            <Field label={`free float, ${symbolA}`} note="balanceOf the vault">
              <Show result={snapshot?.vault.floatA ?? notRead}>
                {(value) => <Num>{fmtAmount(value, decimalsA)}</Num>}
              </Show>
            </Field>
            <Field label={`free float, ${symbolB}`} note="balanceOf the vault">
              <Show result={snapshot?.vault.floatB ?? notRead}>
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
                      currencies off it, so the two figures above are still honest.
                    </span>
                  </>
                )
              ) : (
                <Missing reason={NOT_READ_YET} />
              )}
            </Field>
          </Panel>

          <Panel
            accent="aqua"
            title="Aqua, official"
            meta={<Show result={snapshot?.aqua.address ?? notRead}>{(value) => <Addr value={value} />}</Show>}
            note="Both figures below are getters called on the deployed router, once every poll. The address table on the landing page reads a JSON file, which proves only that somebody typed an address into it."
          >
            <Field label="router AQUA()" note="the one line that proves the official contracts do the work" size="lead">
              <Show result={snapshot?.aqua.routerAqua ?? notRead}>
                {(value) => (
                  <>
                    <Addr value={value} />
                    <Unit>
                      {value.toLowerCase() === CANONICAL_AQUA.toLowerCase() ? (
                        <span className="chip">
                          <span className="led" /> matches the canonical Aqua
                        </span>
                      ) : (
                        <span className="chip bad">
                          <span className="led" /> not the canonical Aqua
                        </span>
                      )}
                    </Unit>
                  </>
                )}
              </Show>
            </Field>
            <Field label="canonical Aqua" note="the same address in solver/src/config.ts and in README.md">
              <Addr value={CANONICAL_AQUA} />
            </Field>
            <Field label="custom opcode" note="OPCODE_UNWIND_PRICED_BALANCE_OUT(), the added instruction" size="lead">
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
          </Panel>
        </section>

        {/*
         * The Uniswap API traffic, behind the landing page's own disclosure, because a judge should not have to
         * take the integration on trust. It opens itself on the first call and stays wherever it is put after
         * that.
         */}
        <details
          className="deployment-disclosure"
          open={netOpen}
          onToggle={(event) => setNetOpen(event.currentTarget.open)}
        >
          <summary>
            <span>
              <strong>Uniswap API traffic</strong>
              <small>
                {netEntries.length
                  ? `${netEntries.length} call${netEntries.length === 1 ? '' : 's'} recorded whole, request body, status and response headers`
                  : 'Nothing yet. Refresh asks /lp/pool_info about this pool'}
                {netRemaining ? `, ${netRemaining} requests left on the key` : ''}
              </small>
            </span>
            <span className="summary-action">Show the raw calls</span>
          </summary>
          <NetworkPanel />
        </details>
      </div>
    </StatedReasonsProvider>
  )
}
