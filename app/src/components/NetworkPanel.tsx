import { useState, useSyncExternalStore } from 'react'

import { stringify } from '../lib/format'
import { lastRateLimitRemaining, netlog, type NetEntry } from '../lib/netlog'
import { LP_HOST } from '../lib/uniswap'
import { Panel } from './primitives'

/**
 * Raw Uniswap API traffic. This panel is the proof that the integration is real: the request body that left,
 * the status, the response that came back, and the rate limit header the gateway answered with.
 *
 * It is a qualifying requirement for the Uniswap track, so it is built to be read rather than to be present:
 * one row per call with the endpoint on the left and the rate limit where the eye lands, and the whole
 * exchange, headers included, one click below it.
 */

function statusClass(entry: NetEntry): string {
  if (entry.error) return 'netstatus bad'
  if (entry.status === null) return 'netstatus pending'
  return entry.status >= 400 ? 'netstatus bad' : 'netstatus ok'
}

function statusText(entry: NetEntry): string {
  if (entry.status !== null) return String(entry.status)
  return entry.error ? 'failed' : 'sent'
}

function Row({ entry }: { entry: NetEntry }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={open ? 'netrow open' : 'netrow'}>
      <button className="netrow-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="netrow-caret">{open ? '▾' : '▸'}</span>
        <span className={statusClass(entry)}>{statusText(entry)}</span>
        <span className="netrow-method">{entry.method}</span>
        <span className="netrow-path">{entry.label}</span>
        <span className="netrow-meta">
          {entry.rateLimitRemaining ? (
            <span className="quota" title="x-ratelimit-remaining, as the gateway sent it">
              {entry.rateLimitRemaining} left
            </span>
          ) : (
            <span className="faint" title="this endpoint does not return x-ratelimit-remaining on every response">
              no quota header
            </span>
          )}
          <span className="netrow-ms">{entry.durationMs === null ? '···' : `${entry.durationMs} ms`}</span>
          <span className="faint">{new Date(entry.startedAt).toLocaleTimeString()}</span>
        </span>
      </button>
      {open ? (
        <div className="netrow-body">
          <div className="upstream">
            {entry.method} {entry.upstream ?? entry.url}
            {entry.apiKeyAttached === null ? null : entry.apiKeyAttached ? (
              // Never "by the dev server": the same proxy is a Vite middleware locally and a Vercel function in
              // production, and on the deployed site the old wording read as a local hack.
              <span className="faint"> , x-api-key attached by the proxy, never in the bundle</span>
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
                response headers, as the gateway sent them
                <span className="faint"> , the rate limit header is only present on some responses</span>
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

export function NetworkPanel() {
  const entries = useSyncExternalStore(netlog.subscribe, netlog.snapshot)
  const remaining = lastRateLimitRemaining(entries)

  return (
    <Panel
      // The disclosure this sits inside is already titled "Uniswap API traffic", so the panel names the host it
      // talked to instead of repeating the concept.
      title={<span className="mono">{LP_HOST.replace('https://', '')}</span>}
      meta={
        <div className="row">
          {/*
           * Three states, not two. The old code showed "no call yet" whenever the header was absent, so a 200
           * from an endpoint that does not send `x-ratelimit-remaining` put the words "no call yet" directly
           * above the call it had just made. On the panel whose entire job is to be believed, that is the worst
           * possible copy.
           */}
          {remaining ? (
            <span className="chip" title="x-ratelimit-remaining on the most recent response that carried it">
              <span className="led" /> {remaining} requests left
            </span>
          ) : entries.length ? (
            <span className="chip" title="the calls below answered without an x-ratelimit-remaining header">
              <span className="led" /> quota not reported
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
      }
    >
      {entries.length ? (
        <div className="netrows">
          {entries.map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
        </div>
      ) : (
        <div className="empty">
          Nothing yet. Press Refresh state or Claim LP fees, neither of which needs a wallet, and the request
          body, the status, the response and every header the gateway sent show up here.
        </div>
      )}
    </Panel>
  )
}
