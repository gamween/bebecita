import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseUnits, type Address, type Hex } from 'viem'

import { NetworkPanel } from '../components/NetworkPanel'
import { Addr, Metric, Show, Unit } from '../components/primitives'
import type { Wallet } from '../App'
import { vaultAbi } from '../lib/abi'
import { CHAIN, publicClient, walletClientFor } from '../lib/client'
import type { AppConfig } from '../lib/config'
import { fillWiring, runFill, type FillResult } from '../lib/fill'
import { addressUrl, ago, amount as fmtAmount, integer, reason, short, stringify, txUrl } from '../lib/format'
import { orderFrom, requestQuote, type QuoteResult } from '../lib/quote'
import { readSnapshot, type Snapshot } from '../lib/state'
import { claimFees, decrease, findTransactionRequest, poolInfo, type TransactionRequest } from '../lib/uniswap'

type Action<T> =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string }

const idle = { status: 'idle' } as const

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

export function Dashboard({ config, wallet }: { config: AppConfig | null; wallet: Wallet }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [live, setLive] = useState(true)

  const [amountInput, setAmountInput] = useState('1')
  const [aToB, setAToB] = useState(true)

  const [quote, setQuote] = useState<Action<QuoteResult>>(idle)
  const [fill, setFill] = useState<Action<FillResult>>(idle)
  const [claim, setClaim] = useState<Action<{ tx: TransactionRequest | null; payload: unknown }>>(idle)
  const [unwind, setUnwind] = useState<Action<{ tx: TransactionRequest | null; payload: unknown }>>(idle)
  const [execution, setExecution] = useState<Action<{ hash: Hex }>>(idle)
  const [apiPool, setApiPool] = useState<Record<string, string | number> | null>(null)

  const chainId = config?.deployment.chainId ?? config?.chain.chainId ?? CHAIN.id
  const wiring = useMemo(() => fillWiring(), [])

  const refresh = useCallback(
    async (options: { withApi?: boolean } = {}) => {
      if (!config) return
      setRefreshing(true)
      try {
        const next = await readSnapshot(config)
        setSnapshot(next)
        setSnapshotError(null)
        // A manual refresh also asks the Uniswap API about the pool, which puts a real request and a real
        // response in the network panel every time somebody presses the button. The auto refresh does not,
        // because the key is rate limited to six requests a second and a demo should not spend that.
        if (options.withApi) {
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

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => void refreshRef.current(), 15_000)
    return () => clearInterval(timer)
  }, [live])

  const decimalsA = snapshot?.tokenA.decimals.ok ? snapshot.tokenA.decimals.value : 18
  const decimalsB = snapshot?.tokenB.decimals.ok ? snapshot.tokenB.decimals.value : 18
  const symbolA = snapshot?.tokenA.symbol.ok ? snapshot.tokenA.symbol.value : 'token A'
  const symbolB = snapshot?.tokenB.symbol.ok ? snapshot.tokenB.symbol.value : 'token B'
  const inSymbol = aToB ? symbolA : symbolB
  const outSymbol = aToB ? symbolB : symbolA
  const inDecimals = aToB ? decimalsA : decimalsB
  const outDecimals = aToB ? decimalsB : decimalsA

  const tokenId = snapshot?.uniswap.tokenId ?? null
  const vaultAddress = config?.deployment.vault ?? null
  const positionManager = config?.deployment.positionManager ?? config?.chain.positionManager ?? null
  const orderResult = config ? orderFrom(config.deployment) : null

  const isVaultOwner =
    wallet.state && snapshot?.vault.owner.ok
      ? wallet.state.address.toLowerCase() === snapshot.vault.owner.value.toLowerCase()
      : false

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
    if (!wallet.state) {
      setFill({ status: 'error', message: 'connect a wallet first, the taker is the address that pays the input' })
      return
    }
    setFill({ status: 'pending' })
    try {
      const value = await runFill({
        amount: parseUnits(amountInput || '0', inDecimals),
        isExactIn: true,
        isAToB: aToB,
        taker: wallet.state.address as Address,
      })
      setFill({ status: 'ok', value })
      void refresh()
    } catch (error) {
      setFill({ status: 'error', message: reason(error) })
    }
  }, [aToB, amountInput, inDecimals, refresh, wallet.state])

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
              {symbolA} to {symbolB}
            </option>
            <option value="ba">
              {symbolB} to {symbolA}
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
          className="btn"
          onClick={() => void onFill()}
          disabled={fill.status === 'pending'}
          title={wiring.detail}
        >
          Run a fill
        </button>
        <button className="btn" onClick={() => void onClaimFees()} disabled={claim.status === 'pending'}>
          Claim fees
        </button>

        <div className="spacer" />
        <label className="toggle">
          <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
          auto refresh, 15 s
        </label>
        <span className="chip" title="block the last read was answered at">
          <span className="led" />
          <Show result={snapshot?.blockNumber ?? { ok: false, reason: 'not read yet' }}>
            {(value) => <>block {integer(value)}</>}
          </Show>
        </span>
        {snapshot ? <span className="chip">{ago(snapshot.at)}</span> : null}
      </div>

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

        <ResultCard title="fill" state={fill}>
          {fill.status === 'ok' ? (
            <dl className="kv">
              <dt>transaction</dt>
              <dd>
                <a href={txUrl(fill.value.transactionHash)} target="_blank" rel="noreferrer">
                  {fill.value.transactionHash}
                </a>
              </dd>
              <dt>amountIn</dt>
              <dd>{fmtAmount(fill.value.amountIn, inDecimals, 6)}</dd>
              <dt>amountOut</dt>
              <dd>{fmtAmount(fill.value.amountOut, outDecimals, 6)}</dd>
              <dt>unwind</dt>
              <dd>{fill.value.unwindPercent} percent of the position</dd>
            </dl>
          ) : null}
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
              <Show result={snapshot?.uniswap.liquidity ?? { ok: false, reason: 'not read yet' }}>
                {(value) => <span className="num">{integer(value)}</span>}
              </Show>
            </Metric>
            <Metric label="current tick" note="StateView.getSlot0">
              <Show result={snapshot?.uniswap.tick ?? { ok: false, reason: 'not read yet' }}>
                {(value) => <span className="num">{value}</span>}
              </Show>
            </Metric>
            <Metric label="position range">
              {snapshot?.uniswap.tickLower.ok && snapshot.uniswap.tickUpper.ok ? (
                <span className="num">
                  {snapshot.uniswap.tickLower.value} to {snapshot.uniswap.tickUpper.value}
                </span>
              ) : (
                <Show result={snapshot?.uniswap.tickLower ?? { ok: false, reason: 'not read yet' }}>
                  {(value) => <span className="num">{value}</span>}
                </Show>
              )}
            </Metric>
            <Metric label="pool liquidity" note="StateView.getLiquidity">
              <Show result={snapshot?.uniswap.poolLiquidity ?? { ok: false, reason: 'not read yet' }}>
                {(value) => <span className="num">{integer(value)}</span>}
              </Show>
            </Metric>
            <Metric label="lp fee">
              <Show result={snapshot?.uniswap.lpFee ?? { ok: false, reason: 'not read yet' }}>
                {(value) => (
                  <span className="num">
                    {value} <Unit>hundredths of a bip</Unit>
                  </span>
                )}
              </Show>
            </Metric>
            <Metric label="position owner">
              <Show result={snapshot?.uniswap.positionOwner ?? { ok: false, reason: 'not read yet' }}>
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
                panel at the bottom.
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
            <Metric label={`free float, ${symbolA}`} note="balanceOf the vault">
              <Show result={snapshot?.vault.floatA ?? { ok: false, reason: 'not read yet' }}>
                {(value) => <span className="num">{fmtAmount(value, decimalsA)}</span>}
              </Show>
            </Metric>
            <Metric label={`free float, ${symbolB}`} note="balanceOf the vault">
              <Show result={snapshot?.vault.floatB ?? { ok: false, reason: 'not read yet' }}>
                {(value) => <span className="num">{fmtAmount(value, decimalsB)}</span>}
              </Show>
            </Metric>

            <div className="subhead">URC-3, hook TVL and effective liquidity reporting</div>
            <Metric label="reserves" note="getReserves(PoolKey), token0 and token1">
              <Show result={snapshot?.vault.reserves ?? { ok: false, reason: 'not read yet' }}>
                {([token0, token1]) => (
                  <span className="num">
                    {fmtAmount(token0, decimalsA)} / {fmtAmount(token1, decimalsB)}
                  </span>
                )}
              </Show>
            </Metric>
            <Metric label="effective liquidity" note="getEffectiveLiquidity(PoolKey), token0 and token1">
              <Show result={snapshot?.vault.effectiveLiquidity ?? { ok: false, reason: 'not read yet' }}>
                {([token0, token1]) => (
                  <span className="num">
                    {fmtAmount(token0, decimalsA)} / {fmtAmount(token1, decimalsB)}
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
              <Show result={snapshot?.vault.reachable ?? { ok: false, reason: 'not read yet' }}>
                {(value) => <span className="num">{fmtAmount(value, decimalsB)}</span>}
              </Show>
            </Metric>
            <Metric label="maxUnwindPct" note="largest share of the position one fill may unwind">
              <Show result={snapshot?.vault.maxUnwindPct ?? { ok: false, reason: 'not read yet' }}>
                {(value) => (
                  <span className="num">
                    {value} <Unit>percent</Unit>
                  </span>
                )}
              </Show>
            </Metric>
            <Metric label="haircutBps" note="safety margin on the deployed leg">
              <Show result={snapshot?.vault.haircutBps ?? { ok: false, reason: 'not read yet' }}>
                {(value) => (
                  <span className="num">
                    {value} <Unit>bps</Unit>
                  </span>
                )}
              </Show>
            </Metric>
            <Metric label="unitsPerLiquidityE18" note="tokenOut units per unit of position liquidity">
              <Show result={snapshot?.vault.unitsPerLiquidityE18 ?? { ok: false, reason: 'not read yet' }}>
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
              <Show result={snapshot?.vault.owner ?? { ok: false, reason: 'not read yet' }}>
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
              <Show result={snapshot?.aqua.address ?? { ok: false, reason: 'not read yet' }}>
                {(value) => <Addr value={value} />}
              </Show>
            </span>
          </div>
          <div className="column-body">
            <Metric label="router AQUA()" note="the one line that proves the official contract does the work">
              <Show result={snapshot?.aqua.routerAqua ?? { ok: false, reason: 'not read yet' }}>
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
              <Show result={snapshot?.aqua.opcode ?? { ok: false, reason: 'not read yet' }}>
                {(value) => (
                  <span className="num">
                    {value.toString()} <Unit>0x{value.toString(16)}</Unit>
                  </span>
                )}
              </Show>
            </Metric>
            <Metric label="app" note="the router the strategy was shipped to">
              {snapshot?.aqua.app ? <Addr value={snapshot.aqua.app} /> : <span className="unavailable">unavailable</span>}
            </Metric>

            <div className="subhead">strategies and raw balances</div>
            {snapshot?.aqua.strategies.length ? (
              snapshot.aqua.strategies.map((strategy) => (
                <div className="strategy" key={strategy.hash}>
                  <div className="hash">{strategy.hash}</div>
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
                            )}
                            <Unit>tokensCount {value.tokensCount}</Unit>
                          </span>
                        )}
                      </Show>
                    </Metric>
                  ))}
                </div>
              ))
            ) : (
              <div className="empty">
                No strategy hash published yet. The setup script writes it to deployments/sepolia.json when the
                vault ships the strategy, and this column reads the balances straight out of the official Aqua.
              </div>
            )}

            <div className="subhead">fill orchestration</div>
            <Metric label="Run a fill" note={wiring.wired ? undefined : 'not wired yet'}>
              {wiring.wired ? (
                <span className="chip">
                  <span className="led" /> wired
                </span>
              ) : (
                <>
                  <span className="unavailable">stubbed</span>
                  <span className="why">{wiring.detail}</span>
                </>
              )}
            </Metric>
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
