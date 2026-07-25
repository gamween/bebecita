import { useCallback, useEffect, useState } from 'react'

import { CHAIN, connectWallet, getProvider, onWalletEvent, readWallet, switchToSepolia, type WalletState } from './lib/client'
import { loadConfig, type AppConfig } from './lib/config'
import { reason, short } from './lib/format'
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

export interface Wallet {
  state: WalletState | null
  error: string | null
  busy: boolean
  connect: () => void
  switchChain: () => void
  hasProvider: boolean
}

function useWallet(): Wallet {
  const [state, setState] = useState<WalletState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const hasProvider = Boolean(getProvider())

  const sync = useCallback(() => {
    readWallet()
      .then(setState)
      .catch((cause) => setError(reason(cause)))
  }, [])

  useEffect(() => {
    sync()
    return onWalletEvent(sync)
  }, [sync])

  const connect = useCallback(() => {
    setBusy(true)
    setError(null)
    connectWallet()
      .then(setState)
      .catch((cause) => setError(reason(cause)))
      .finally(() => setBusy(false))
  }, [])

  const switchChain = useCallback(() => {
    setBusy(true)
    setError(null)
    switchToSepolia()
      .then(sync)
      .catch((cause) => setError(reason(cause)))
      .finally(() => setBusy(false))
  }, [sync])

  return { state, error, busy, connect, switchChain, hasProvider }
}

function WalletButton({ wallet }: { wallet: Wallet }) {
  if (!wallet.hasProvider) {
    return (
      <span className="chip warn" title="This app talks to window.ethereum directly, with viem and no wallet kit.">
        <span className="led" /> no injected wallet
      </span>
    )
  }
  if (!wallet.state) {
    return (
      <button className="btn small" onClick={wallet.connect} disabled={wallet.busy}>
        {wallet.busy ? 'connecting' : 'connect wallet'}
      </button>
    )
  }
  if (wallet.state.chainId !== CHAIN.id) {
    return (
      <button className="btn small" onClick={wallet.switchChain} disabled={wallet.busy}>
        switch to Sepolia
      </button>
    )
  }
  return (
    <span className="chip" title={wallet.state.address}>
      <span className="led" /> {short(wallet.state.address, 6, 4)}
    </span>
  )
}

export function App() {
  const route = useRoute()
  const wallet = useWallet()
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
            <span className="chip" title={`chainId ${CHAIN.id}`}>
              <span className="led" /> Ethereum Sepolia
            </span>
            <WalletButton wallet={wallet} />
          </nav>
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
        {onApp ? <Dashboard config={config} wallet={wallet} /> : <Landing config={config} />}
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
