import { useEffect, useState } from 'react'
import { useBlockNumber } from 'wagmi'

import { WalletButton } from './components/Wallet'
import { CHAIN } from './lib/client'
import { loadConfig, type AppConfig } from './lib/config'
import { ago, integer, reason } from './lib/format'
import { Dashboard } from './pages/Dashboard'
import { Landing } from './pages/Landing'

function useRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#/, '') || '/')
  useEffect(() => {
    const onHashChange = () => setRoute(window.location.hash.replace(/^#/, '') || '/')
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  return route
}

/** A clock, so "3s ago" ages on screen instead of only when something else re-renders. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

/** Over this, the head has stopped moving and the number on screen is no longer a live one. */
const STALE_AFTER_MS = 20_000

/**
 * The head of the chain and how old this page's copy of it is.
 *
 * wagmi watches it, which on an HTTP transport is a poll on the config's own interval, so this is the one
 * timer in the top bar and every panel below reads its own state on its own.
 */
function BlockChip() {
  const { data, dataUpdatedAt, isError, error } = useBlockNumber({ watch: true })
  const now = useNow()

  if (isError || (!data && dataUpdatedAt === 0)) {
    return (
      <span className="chip warn" title={error ? reason(error) : 'no endpoint has answered yet'}>
        <span className="led" /> {isError ? 'no block' : 'reading the head'}
      </span>
    )
  }

  const age = now - dataUpdatedAt
  const stale = age > STALE_AFTER_MS
  return (
    <span
      className={stale ? 'chip warn' : 'chip'}
      title={stale ? 'the head has not moved for a while, the endpoint may be rate limiting' : 'head of the chain'}
    >
      <span className="led" />
      <span className="mono">block {data ? integer(data) : '····'}</span>
      <span className="faint">{ago(dataUpdatedAt, now)}</span>
    </span>
  )
}

export function App() {
  const route = useRoute()
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)

  useEffect(() => {
    loadConfig()
      .then(setConfig)
      .catch((cause) => setConfigError(reason(cause)))
  }, [])

  const onApp = route.startsWith('/app')

  return (
    <div className="shell">
      <header className="topbar">
        <div className="wrap topbar-inner">
          <a className="wordmark" href="#/">
            <span className="dot" /> bebecita <small>Aqua x Uniswap v4</small>
          </a>
          <nav className="nav">
            <a className={onApp ? '' : 'active'} href="#/">
              landing
            </a>
            <a className={onApp ? 'active' : ''} href="#/app">
              app
            </a>
          </nav>
          {/* Chain, block, wallet, in that order, and nothing else. */}
          <div className="status">
            <span className="chip" title={`chainId ${CHAIN.id}`}>
              <span className="led" /> Ethereum Sepolia
            </span>
            <BlockChip />
            <WalletButton />
          </div>
        </div>
      </header>

      <main>
        {configError ? (
          <div className="wrap" style={{ paddingTop: 20 }}>
            <div className="banner bad">
              The address files could not be loaded: {configError}. They are served from deployments/sepolia.json
              and solver/src/config.ts by the dev server.
            </div>
          </div>
        ) : null}
        {onApp ? <Dashboard config={config} /> : <Landing config={config} />}
      </main>

      <footer className="footer">
        <div className="wrap" style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <span>Ethereum Sepolia, chainId {CHAIN.id}</span>
          <span>every number on this site is read from the chain or from the Uniswap API</span>
          <a href="https://sepolia.etherscan.io" target="_blank" rel="noreferrer">
            Etherscan
          </a>
          <a href="https://gov.uniswap.org/t/urc-3-hook-tvl-and-effective-liquidity-reporting/26155" target="_blank" rel="noreferrer">
            URC-3
          </a>
        </div>
      </footer>
    </div>
  )
}
