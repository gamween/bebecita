import { Fragment } from 'react'

import type { AppConfig } from '../lib/config'
import { addressUrl } from '../lib/format'

const STEPS = [
  {
    index: '01',
    head: 'instruction 0x92 clamps',
    body: 'runLoop reads the vault free float and the position liquidity, and clamps balanceOut to what is genuinely reachable. The instruction is fully view, so the quote and the swap agree by construction.',
    className: 's1',
  },
  {
    index: '02',
    head: 'preTransferOut unwinds',
    body: 'The vault executes the /lp/decrease calldata the Uniswap API built for this fill, against the v4 PositionManager. The position unwinds, the vault receives the output token.',
    className: 's2',
  },
  {
    index: '03',
    head: 'AQUA.pull pays the taker',
    body: 'A safeTransferFrom out of the vault, on the very next statement. The money only has to exist for the width of two instructions.',
    className: 's3',
  },
  {
    index: '04',
    head: 'AQUA.push credits the vault',
    body: 'The taker input lands on the maker virtual balance inside the official Aqua contract.',
    className: 's4',
  },
  {
    index: '05',
    head: 'postTransferIn redeposits',
    body: 'The vault executes the /lp/increase calldata. The inventory goes back to work, two sided, so the position stays in range and keeps earning fees.',
    className: 's5',
  },
]

function Arrow({ labelled = false }: { labelled?: boolean }) {
  return (
    <div className={labelled ? 'arrow labelled' : 'arrow'}>
      <svg width={labelled ? 140 : 32} height="12" viewBox={`0 0 ${labelled ? 140 : 32} 12`} aria-hidden="true">
        <line
          x1="0"
          y1="6"
          x2={labelled ? 128 : 22}
          y2="6"
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray={labelled ? '4 3' : undefined}
        />
        <path d={`M${labelled ? 128 : 22} 1 L${labelled ? 139 : 31} 6 L${labelled ? 128 : 22} 11 Z`} fill="currentColor" />
      </svg>
      {labelled ? (
        <div className="label">
          SwapVM.sol:310-314
          <br />
          :321
          <span>consecutive statements</span>
        </div>
      ) : null}
    </div>
  )
}

function ContractTable({ config }: { config: AppConfig | null }) {
  const deployment = config?.deployment ?? {}
  const chain = config?.chain ?? {}

  const rows: Array<{ name: string; note: string; address?: string }> = [
    { name: 'BebecitaRouter', note: 'our SwapVM, one extra instruction at 0x92', address: deployment.router },
    { name: 'BebecitaVault', note: 'the maker, custodian of the position', address: deployment.vault },
    { name: 'test token A', note: 'ERC20 minted for the demo pair', address: deployment.tokenA },
    { name: 'test token B', note: 'the other side of the book', address: deployment.tokenB },
    { name: 'Aqua', note: 'official 1inch deployment, canonical address', address: deployment.aqua ?? chain.aqua },
    { name: 'AquaSwapVMRouter', note: 'official 1inch router, the comparison', address: chain.officialRouter },
    {
      name: 'v4 PositionManager',
      note: 'getPositionLiquidity(uint256), selector 0x1efeed33',
      address: deployment.positionManager ?? chain.positionManager,
    },
    { name: 'v4 StateView', note: 'pool slot0 and pool liquidity', address: chain.stateView },
    { name: 'v4 PoolManager', note: 'the pool itself', address: chain.poolManager },
  ]

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Contract</th>
            <th>What it is</th>
            <th>Address</th>
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
      <section className="hero">
        <div className="wrap">
          <div className="eyebrow">live on ethereum sepolia, 1inch aqua, uniswap v4</div>
          <h1>An order book funded by a Uniswap position.</h1>
          <p className="lede">
            The maker inventory never sits idle in a wallet. It stays in a Uniswap v4 liquidity position, earning
            fees, and it is unwound just in time, one instruction before the tokens leave, inside the same
            transaction as the fill. A custom SwapVM instruction at opcode 0x92 clamps the quotable balance to
            what is genuinely reachable, so the book never quotes depth it cannot deliver.
          </p>
          <div className="cta">
            <a className="btn primary" href="#/app" style={{ borderBottom: 'none' }}>
              Open the app
            </a>
            {config?.deployment.router ? (
              <a className="btn ghost" href={addressUrl(config.deployment.router)} target="_blank" rel="noreferrer">
                BebecitaRouter on Etherscan
              </a>
            ) : null}
            <span className="chip">
              <span className="led" /> chainId 11155111
            </span>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <h2>The removal test, both ways</h2>
          <p className="sub">
            The shortest true description of the project, and the first thing a reviewer should check. Both legs
            break. Neither is decoration.
          </p>
          <div className="two-up">
            <div className="card removal">
              <span className="tag">take the Uniswap API out</span>
              <p>
                There is no calldata to place in either hook slice, the vault has no free float, and AQUA.pull
                reverts on the first fill on a safeTransferFrom out of an empty wallet. There is no degraded mode.
              </p>
              <p className="faint">
                /lp/decrease and /lp/increase are executed on chain inside every fill. The API is the funding
                mechanism, not a data source.
              </p>
            </div>
            <div className="card removal second">
              <span className="tag">take the custom instruction out</span>
              <p>
                Aqua quotes against the virtual balance the maker shipped, which is enormous by construction, the
                curve prices depth that does not exist, and every fill dies at the last statement when the unwind
                cannot produce what was promised.
              </p>
              <p className="faint">
                That failure is asserted in the test suite rather than described, in
                test_WithoutInstruction_QuotePassesAndSwapReverts.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <h2>One fill, five boxes</h2>
          <p className="sub">
            Everything below happens inside a single transaction. The settlement window is two consecutive
            statements wide.
          </p>
          <div className="diagram">
            <div className="diagram-row">
              {STEPS.map((step, index) => (
                <Fragment key={step.index}>
                  <div className={`step ${step.className}`}>
                    <div className="index">{step.index}</div>
                    <div className="head">{step.head}</div>
                    <div className="body">{step.body}</div>
                  </div>
                  {index < STEPS.length - 1 ? <Arrow labelled={index === 1} /> : null}
                </Fragment>
              ))}
            </div>
          </div>
          <p className="diagram-note">
            Steps two and three are consecutive statements in the sponsor own source, and that ordering holds in
            both transfer orders the router supports. preTransferOut is the only point in SwapVM guaranteed to run
            immediately before tokens leave the maker, which is the entire reason this design exists.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <h2>Live on Ethereum Sepolia</h2>
          <p className="sub">
            The only chain outside mainnet that carries both halves of this project. The official Aqua is deployed
            there at its canonical address, with bytecode byte for byte identical to the Base deployment, and the
            Uniswap API accepts chainId 11155111. The addresses below are read from deployments/sepolia.json and
            solver/src/config.ts, never copied.
          </p>
          <ContractTable config={config} />
          <p className="sub" style={{ marginTop: 16 }}>
            The router AQUA() getter returns the canonical Aqua address, which is the one line that proves the
            official contracts are the ones doing the work, and OPCODE_UNWIND_PRICED_BALANCE_OUT() returns 146,
            that is 0x92. Both are read live in the app.
          </p>
        </div>
      </section>

      <section className="section" style={{ borderBottom: 0 }}>
        <div className="wrap">
          <h2>See it move</h2>
          <p className="sub">
            The app reads the position liquidity from the v4 PositionManager, the reserves and effective liquidity
            the vault reports under URC-3, and the raw balances the official Aqua holds for each strategy hash. It
            also shows every Uniswap API request and response, with the x-ratelimit-remaining header, because an
            API integration has to be provable on screen.
          </p>
          <div className="cta">
            <a className="btn primary" href="#/app" style={{ borderBottom: 'none' }}>
              Open the app
            </a>
          </div>
        </div>
      </section>
    </>
  )
}
