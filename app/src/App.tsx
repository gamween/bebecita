import { useEffect, useState } from 'react'

import { WalletButton } from './components/Wallet'
import { CHAIN } from './lib/client'
import { loadConfig, type AppConfig } from './lib/config'
import { reason } from './lib/format'
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

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
    document.title = onApp ? 'Live settlement' : 'One position, two markets'
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [onApp])

  return (
    <div className="shell">
      <button
        className="skip-link"
        type="button"
        onClick={() => {
          const main = document.getElementById('main-content')
          main?.focus({ preventScroll: true })
          main?.scrollIntoView()
        }}
      >
        Skip to content
      </button>
      <header className={onApp ? 'topbar' : 'topbar topbar-landing'}>
        <div className="wrap topbar-inner">
          {onApp ? (
            <nav className="nav" aria-label="Primary navigation">
              <a href="#/">Overview</a>
              <a className="active" href="#/app" aria-current="page">
                Live console
              </a>
            </nav>
          ) : null}
          {onApp ? (
            <div className="status">
              <span className="chip" title={`chainId ${CHAIN.id}`}>
                <span className="led" /> Ethereum Sepolia
              </span>
              <WalletButton />
            </div>
          ) : null}
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
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
        <div className="wrap footer-inner">
          <span>Sepolia · chainId {CHAIN.id}</span>
          <div className="footer-links">
            <a href="https://sepolia.etherscan.io" target="_blank" rel="noreferrer">
              Etherscan
            </a>
            <a
              href="https://gov.uniswap.org/t/urc-3-hook-tvl-and-effective-liquidity-reporting/26155"
              target="_blank"
              rel="noreferrer"
            >
              URC-3
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
