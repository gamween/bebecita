import { useCallback, useEffect, useMemo, useState } from 'react'
import { parseUnits, type Address, type Hex } from 'viem'
import { useConnection, useWalletClient } from 'wagmi'

import { Panel, TxLink } from '../components/primitives'
import { TxStatus } from '../components/Tx'
import { vaultAbi } from '../lib/abi'
import { CHAIN } from '../lib/client'
import type { AppConfig } from '../lib/config'
import { describeError } from '../lib/errors'
import { approveRouter, mintTo, readTakerPosition, runFill, type FillResult } from '../lib/fill'
import { amount as fmtAmount, exact, reason, shortAddress } from '../lib/format'
import { orderFrom, requestQuote, type QuoteResult } from '../lib/quote'
import { readinessOf } from '../lib/readiness'
import { readSnapshot, tokenOf, type Snapshot } from '../lib/state'
import { txIdle, useTx, type TxState } from '../lib/tx'
import { claimFees, findTransactionRequest, type TransactionRequest } from '../lib/uniswap'

const MINT_AMOUNT = 10_000n * 10n ** 18n
const STATE_POLL_MS = 5_000

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

  const refresh = useCallback(async () => {
    if (!config) return
    setRefreshing(true)
    try {
      setSnapshot(await readSnapshot(config, []))
      setSnapshotError(null)
    } catch (error) {
      setSnapshotError(reason(error))
    } finally {
      setRefreshing(false)
    }
  }, [config])

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
    <div className="wrap dash client-console">
      <header className="dashboard-intro">
        <h1 tabIndex={-1}>Live settlement</h1>
        <div className="dashboard-intro-meta">
          <span className="console-state">
            <span
              className={
                readiness.phase === 'ready' ? 'led' : readiness.phase === 'failed' ? 'led bad' : 'led pulse'
              }
            />
            {readiness.phase === 'ready'
              ? 'Ready'
              : readiness.phase === 'failed'
                ? 'Connection failed'
                : 'Connecting'}
          </span>
        </div>
      </header>

      <div className="readiness-stack" aria-live="polite">
        {readiness.phase === 'failed' ? <div className="banner bad">{snapshotError}</div> : null}
        {config?.problems.length ? <div className="banner bad">{config.problems.join(' · ')}</div> : null}
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
          <button className="btn small ghost" onClick={() => void refresh()} disabled={refreshing || !config}>
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
    </div>
  )
}
