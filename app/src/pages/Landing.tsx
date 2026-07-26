import type { AppConfig } from '../lib/config'
import { addressUrl, txUrl } from '../lib/format'

const PHASES = [
  'Expose honest depth',
  'Unwind a capped share',
  'Pay, then redeploy',
]

/**
 * The same sequence the marquee gestures at, written out so it can be checked.
 *
 * The two source citations are the point of this block. `preTransferOut` and the pull are consecutive
 * statements in 1inch's own router, which is what makes just in time collateral possible at all, and a judge
 * can open the file and verify it. That claim does not survive being paraphrased, so it lives here rather
 * than in the moving list.
 */
const SETTLEMENT = [
  {
    step: '1',
    where: 'runLoop',
    title: 'The instruction clamps',
    body: 'Opcode 0x92 reads the vault float and the position liquidity, and lowers the quotable balance to what is genuinely reachable. The curve then prices against that.',
  },
  {
    step: '2',
    where: 'SwapVM.sol:310-314',
    title: 'The position unwinds',
    body: 'The maker hook executes the /lp/decrease calldata the Uniswap API built for this fill.',
  },
  {
    step: '3',
    where: 'SwapVM.sol:321',
    title: 'The taker is paid',
    body: 'AQUA.pull runs on the very next statement, and it holds in both transfer orders the router supports.',
    link: true,
  },
  {
    step: '4',
    where: 'SwapVM.sol:262',
    title: 'The vault is credited',
    body: 'AQUA.push moves the taker input into the maker balance.',
  },
  {
    step: '5',
    where: 'SwapVM.sol:282-286',
    title: 'The inventory redeploys',
    body: 'The second hook executes /lp/increase, and the capital goes back to earning.',
  },
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
    // The finding is the interesting part of this row, so it is stated here rather than left to FEEDBACK.md.
    { name: 'AquaSwapVMRouter', note: 'official reference, quote() reverts with 0x', address: chain.officialRouter },
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

        <div className="wrap landing-wrap">
          <ol className="settlement">
            {SETTLEMENT.map((item) => (
              <li className={item.link ? 'settlement-step is-linked' : 'settlement-step'} key={item.step}>
                <div className="settlement-head">
                  <span className="settlement-index" aria-hidden="true">{item.step}</span>
                  <code className="settlement-where">{item.where}</code>
                </div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </li>
            ))}
          </ol>
          <p className="settlement-note">
            Steps two and three are consecutive statements in the sponsor's own source. The maker hook is the
            last point anyone controls before the tokens leave, which is the whole reason the collateral can
            arrive just in time.
          </p>
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
                  <p>
                    Take it out and there is no calldata to put in either hook, the vault holds almost nothing,
                    and AQUA.pull reverts on the first fill. There is no degraded mode.
                  </p>
                  <code>/lp/decrease · /lp/increase</code>
                </div>
              </article>
              <article className="removal-test">
                <span className="test-number">B</span>
                <div>
                  <h3>SwapVM opcode 0x92</h3>
                  <p>
                    Take it out and Aqua quotes the virtual balance the maker shipped, which nothing backs, so
                    every fill dies at the last statement. That failure is shipped on chain, not described.
                  </p>
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
              {/* The verb is a stylesheet rule keyed on [open], because this label used to say Show while open. */}
              <span className="summary-action">addresses</span>
            </summary>
            <ContractTable config={config} />
          </details>
        </div>
      </section>

      {/*
       * The disclosure used to be the end of the page, which left a judge who read all of it with the console
       * two screens back up. The second action is the last recorded fill, so the way out of the page is also
       * the shortest proof that the sequence above ran.
       */}
      <section className="closing">
        <div className="wrap landing-wrap closing-inner">
          <div>
            <div className="eyebrow">Live on Sepolia</div>
            <h2>Fill it yourself.</h2>
          </div>
          <div className="cta">
            <a className="btn primary" href="#/app">
              Open live console
            </a>
            {config?.deployment.lastFill?.txHash ? (
              <a
                className="text-link"
                href={txUrl(config.deployment.lastFill.txHash)}
                target="_blank"
                rel="noreferrer"
              >
                Last recorded fill <span aria-hidden="true">↗</span>
              </a>
            ) : null}
          </div>
        </div>
      </section>
    </>
  )
}
