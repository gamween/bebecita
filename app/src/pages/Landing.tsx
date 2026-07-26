import type { AppConfig } from '../lib/config'
import { addressUrl } from '../lib/format'

const PHASES = [
  'Expose honest depth',
  'Unwind a capped share',
  'Pay, then redeploy',
]

function ContractTable({ config }: { config: AppConfig | null }) {
  const deployment = config?.deployment ?? {}
  const chain = config?.chain ?? {}

  const rows: Array<{ name: string; note: string; address?: string }> = [
    { name: 'Router', note: 'SwapVM + opcode 0x92', address: deployment.router },
    { name: 'Vault', note: 'maker and LP custodian', address: deployment.vault },
    { name: 'test token A', note: 'demo asset', address: deployment.tokenA },
    { name: 'test token B', note: 'demo asset', address: deployment.tokenB },
    { name: 'Aqua', note: 'official 1inch deployment', address: deployment.aqua ?? chain.aqua },
    { name: 'AquaSwapVMRouter', note: 'official reference router', address: chain.officialRouter },
    {
      name: 'v4 PositionManager',
      note: 'position execution',
      address: deployment.positionManager ?? chain.positionManager,
    },
    { name: 'v4 StateView', note: 'pool state', address: chain.stateView },
    { name: 'v4 PoolManager', note: 'Uniswap v4 pool', address: chain.poolManager },
  ]

  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Project contracts deployed on Ethereum Sepolia</caption>
        <thead>
          <tr>
            <th scope="col">Contract</th>
            <th scope="col">Role</th>
            <th scope="col">Address</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td className="muted">{row.note}</td>
              <td className="addr">
                {row.address ? (
                  <a href={addressUrl(row.address)} target="_blank" rel="noreferrer">
                    {row.address}
                  </a>
                ) : (
                  <span className="unavailable">unavailable</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Landing({ config }: { config: AppConfig | null }) {
  return (
    <>
      <section className="hero" id="overview">
        <div className="wrap landing-wrap hero-grid">
          <div className="hero-copy">
            <div className="eyebrow">Aqua × Uniswap v4</div>
            <h1 tabIndex={-1}>
              One position.
              <br />
              <em>Two markets.</em>
            </h1>
            <p className="lede">
              A Uniswap LP position that stays productive while backing an Aqua order.
            </p>
            <div className="cta">
              <a className="btn primary" href="#/app">
                Open live console
              </a>
              {config?.deployment.router ? (
                <a className="text-link" href={addressUrl(config.deployment.router)} target="_blank" rel="noreferrer">
                  View contract <span aria-hidden="true">↗</span>
                </a>
              ) : null}
            </div>
          </div>

          <div className="hero-orbit" aria-hidden="true">
            <svg className="hero-orbit-art" viewBox="0 0 360 360">
              <g className="hero-orbit-outer">
                <path d="M180 26C270 20 336 90 332 181C328 270 267 338 176 333C87 329 22 267 27 177C31 88 91 31 180 26Z" />
                <circle className="hero-orbit-accent" cx="180" cy="26" r="5" />
              </g>
              <g className="hero-orbit-mid hero-orbit-mid-a">
                <ellipse cx="180" cy="180" rx="145" ry="91" />
              </g>
              <g className="hero-orbit-mid hero-orbit-mid-b">
                <ellipse cx="180" cy="180" rx="145" ry="91" />
              </g>
              <circle className="hero-orbit-core" cx="180" cy="180" r="42" />
              <circle className="hero-orbit-cutout" cx="197" cy="164" r="17" />
            </svg>
          </div>
        </div>
      </section>

      <div className="wrap landing-wrap">
        <ul className="proof-strip" aria-label="Integration proofs">
          <li>Official Aqua</li>
          <li>Opcode 0x92</li>
          <li>Uniswap LP API</li>
          <li>Atomic fill</li>
        </ul>
      </div>

      <section className="section mechanism" id="mechanism">
        <div className="wrap landing-wrap">
          <div className="section-intro">
            <div>
              <div className="eyebrow">One fill</div>
              <h2>Withdraw. Settle. Redeploy.</h2>
            </div>
            <p>The order quotes only what the vault can reach.</p>
          </div>
        </div>

        <div
          className="phase-marquee"
          role="region"
          aria-label="Settlement sequence. Focus or hover to pause the moving list."
          tabIndex={0}
        >
          <div className="phase-track">
            {[false, true].map((duplicate) => (
              <ol className="phase-list" aria-hidden={duplicate || undefined} key={duplicate ? 'copy' : 'primary'}>
                {PHASES.map((title) => (
                  <li className="phase" key={title}>
                    <h3>{title}</h3>
                    <span className="phase-plus" aria-hidden="true">
                      +
                    </span>
                  </li>
                ))}
              </ol>
            ))}
          </div>
        </div>
      </section>

      <section className="section proof-section" id="proof">
        <div className="wrap landing-wrap">
          <div className="proof-layout">
            <div className="proof-heading">
              <div className="eyebrow">Real integrations</div>
              <h2>Both sides execute.</h2>
              <p>Remove either one and LP-backed settlement cannot complete.</p>
            </div>

            <div className="removal-tests">
              <article className="removal-test">
                <span className="test-number">A</span>
                <div>
                  <h3>Uniswap LP API</h3>
                  <p>Builds the decrease and increase calls executed by the vault.</p>
                  <code>/lp/decrease · /lp/increase</code>
                </div>
              </article>
              <article className="removal-test">
                <span className="test-number">B</span>
                <div>
                  <h3>SwapVM opcode 0x92</h3>
                  <p>Stops the order from quoting more than the position can release.</p>
                  <code>reachableFromPosition() · clamp</code>
                </div>
              </article>
            </div>
          </div>

          <details className="deployment-disclosure">
            <summary>
              <span>
                <strong>Sepolia deployments</strong>
                <small>Contracts used by the live demo</small>
              </span>
              <span className="summary-action">Show addresses</span>
            </summary>
            <ContractTable config={config} />
          </details>
        </div>
      </section>

    </>
  )
}
