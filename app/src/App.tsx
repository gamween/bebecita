import { useEffect, useState } from 'react'

import { WalletButton } from './components/Wallet'
import { CHAIN } from './lib/client'
import { loadConfig, type AppConfig } from './lib/config'
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

  // `loadConfig` collects its own failures into `problems` and always resolves, so there is no rejection path.
  useEffect(() => {
    loadConfig().then(setConfig)
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
          ) : (
            /* The landing bar carries the mark and one quiet way in. The wallet belongs to the console. */
            <>
              <a className="wordmark" href="#/">
                bebecita
              </a>
              <a className="text-link" href="#/app">
                Live console <span aria-hidden="true">↗</span>
              </a>
            </>
          )}
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
        {/*
         * Both routes read the same two address records, and a 404 on either one turns every address and
         * balance on the page into "unavailable" with nothing saying why. The console states the same list
         * next to its own snapshot error, so this copy only covers the landing route.
         */}
        {!onApp && config?.problems.length ? (
          <div className="wrap landing-wrap" style={{ paddingTop: 20 }}>
            <div className="banner bad">
              The addresses on this page come from deployments/sepolia.json and deployments/chain.json, and they
              could not be read: {config.problems.join(' · ')}
            </div>
          </div>
        ) : null}
        {onApp ? <Dashboard config={config} /> : <Landing config={config} />}
      </main>

      <footer className="footer">
        <div className="wrap footer-inner">
          <span>Sepolia · chainId {CHAIN.id}</span>
          <div className="footer-links">
            {/* Both of these are qualifying rows for the Uniswap track, so they are reachable from every page. */}
            <a href="https://github.com/gamween/bebecita" target="_blank" rel="noreferrer">
              Source, MIT
            </a>
            <a href="https://github.com/gamween/bebecita/blob/main/FEEDBACK.md" target="_blank" rel="noreferrer">
              FEEDBACK.md
            </a>
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
