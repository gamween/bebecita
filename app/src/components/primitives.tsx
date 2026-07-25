import type { ReactNode } from 'react'

import { addressUrl, short, type Result } from '../lib/format'

export function Metric({
  label,
  note,
  children,
  big = false,
}: {
  label: string
  note?: string
  children: ReactNode
  big?: boolean
}) {
  return (
    <div className={big ? 'metric big' : 'metric'}>
      <div className="label">
        {label}
        {note ? <span className="note">{note}</span> : null}
      </div>
      <div className="value">{children}</div>
    </div>
  )
}

/**
 * Renders a value that was read on chain, or the reason it could not be read. Nothing here ever falls back to
 * a placeholder number: unavailable is a legitimate state while the position is still being created.
 */
export function Show<T>({ result, children }: { result: Result<T>; children: (value: T) => ReactNode }) {
  if (result.ok) return <>{children(result.value)}</>
  return (
    <>
      <span className="unavailable">unavailable</span>
      <span className="why">{result.reason}</span>
    </>
  )
}

export function Addr({ value, length = 6 }: { value: string; length?: number }) {
  return (
    <a className="mono" href={addressUrl(value)} target="_blank" rel="noreferrer" title={value}>
      {short(value, length, 4)}
    </a>
  )
}

export function Unit({ children }: { children: ReactNode }) {
  return <span className="unit">{children}</span>
}
