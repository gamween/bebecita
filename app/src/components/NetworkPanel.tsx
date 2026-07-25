import { useState, useSyncExternalStore } from 'react'

import { stringify } from '../lib/format'
import { lastRateLimitRemaining, netlog, type NetEntry } from '../lib/netlog'

function statusClass(entry: NetEntry): string {
  if (entry.error) return 'status bad'
  if (entry.status === null) return 'status pending'
  return entry.status >= 400 ? 'status bad' : 'status'
}

function Row({ entry }: { entry: NetEntry }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="netrow">
      <div className="netrow-head" onClick={() => setOpen(!open)}>
        <span className="faint">{open ? '▾' : '▸'}</span>
        <span className={statusClass(entry)}>{entry.status ?? (entry.error ? 'failed' : 'pending')}</span>
        <span className="path">{entry.label}</span>
        <span className="meta">
          {entry.rateLimitRemaining ? (
            <span className="quota">x-ratelimit-remaining: {entry.rateLimitRemaining}</span>
          ) : (
            <span className="faint">no rate limit header</span>
          )}
          <span>{entry.durationMs === null ? '...' : `${entry.durationMs} ms`}</span>
          <span>{new Date(entry.startedAt).toLocaleTimeString()}</span>
        </span>
      </div>
      {open ? (
        <div className="netrow-body">
          <div className="upstream">
            {entry.method} {entry.upstream ?? entry.url}
            {entry.apiKeyAttached === null ? null : entry.apiKeyAttached ? (
              <span className="faint"> , x-api-key attached by the dev server</span>
            ) : (
              <span className="unavailable"> , no x-api-key was attached, UNISWAP_API_KEY is empty in .env</span>
            )}
          </div>
          <div>
            <div className="pre-label">request body</div>
            <pre className="json">{stringify(entry.request)}</pre>
          </div>
          <div>
            <div className="pre-label">response {entry.error ? `, ${entry.error}` : ''}</div>
            <pre className="json">{entry.response === null ? entry.error ?? 'no body' : stringify(entry.response)}</pre>
          </div>
          {Object.keys(entry.responseHeaders).length ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="pre-label">
                response headers, as the gateway sent them. The rate limit header is only present on some
                responses, so it is shown here whenever it is.
              </div>
              <pre className="json">
                {Object.entries(entry.responseHeaders)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join('\n')}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Raw Uniswap API traffic. This panel is the proof that the integration is real: the request body that left,
 * the status, the response that came back, and the rate limit header the gateway answered with.
 */
export function NetworkPanel() {
  const entries = useSyncExternalStore(netlog.subscribe, netlog.snapshot)
  const remaining = lastRateLimitRemaining(entries)

  return (
    <section className="netpanel">
      <div className="netpanel-head">
        <h3>Uniswap API traffic</h3>
        <span className="faint mono" style={{ fontSize: 12 }}>
          liquidity.api.uniswap.org
        </span>
        <span className="spacer" />
        {remaining ? (
          <span className="chip">
            <span className="led" /> x-ratelimit-remaining {remaining}
          </span>
        ) : (
          <span className="chip warn">
            <span className="led" /> no call yet
          </span>
        )}
        <button className="btn small ghost" onClick={() => netlog.clear()} disabled={!entries.length}>
          clear
        </button>
      </div>
      {entries.length ? (
        entries.map((entry) => <Row key={entry.id} entry={entry} />)
      ) : (
        <div className="empty" style={{ padding: '14px 16px' }}>
          Nothing yet. Refresh the state, ask for the unwind calldata or claim the fees, and every request and
          response shows up here with its rate limit header.
        </div>
      )}
    </section>
  )
}
