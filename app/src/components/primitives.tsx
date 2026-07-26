import { createContext, useContext, type ReactNode } from 'react'

import { addressUrl, shortAddress, shortHash, txUrl, type Result } from '../lib/format'

/**
 * The pieces the panels on this page are built from.
 *
 * Three of them carry the layout: a `Panel` holds `Field`s grouped by `Subhead`s, so spacing, heading weight
 * and the alignment of the value column are decided once, in one stylesheet block, instead of drifting per
 * section. The rest are there so a section never has to invent its own way of saying something. `Show` and
 * `Missing` render the reason a read did not land, `Placeholder` is the quiet form of that reason once the page
 * has stated it, and `Addr`, `TxLink`, `Num` and `Unit` put an address, a hash or a figure in the monospace
 * column with the explorer link and the tabular digits already attached.
 */

/**
 * Reasons the page has already stated once, at the top.
 *
 * A field whose reason is in this set renders as a quiet placeholder instead of repeating it. Before the
 * first read lands every field on the page carries the same reason, and printing it twenty five times reads
 * as twenty five failures rather than as one page that has not loaded.
 */
const StatedReasons = createContext<ReadonlySet<string>>(new Set<string>())

export function StatedReasonsProvider({ value, children }: { value: ReadonlySet<string>; children: ReactNode }) {
  return <StatedReasons.Provider value={value}>{children}</StatedReasons.Provider>
}

export type PanelAccent = 'uniswap' | 'vault' | 'aqua' | 'neutral' | 'ok' | 'bad' | 'pending'

export function Panel({
  accent = 'neutral',
  title,
  meta,
  note,
  foot,
  children,
}: {
  accent?: PanelAccent
  title: ReactNode
  meta?: ReactNode
  note?: ReactNode
  foot?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={`panel panel-${accent}`}>
      <div className="panel-head">
        <h3>{title}</h3>
        {meta ? <div className="panel-meta">{meta}</div> : null}
        {note ? <div className="panel-note">{note}</div> : null}
      </div>
      <div className="panel-body">{children}</div>
      {foot ? <div className="panel-foot">{foot}</div> : null}
    </section>
  )
}

/** One label and one value, on one row, with the value in the monospace column on the right. */
export function Field({
  label,
  note,
  children,
  size = 'normal',
}: {
  label: ReactNode
  note?: ReactNode
  children: ReactNode
  size?: 'normal' | 'lead'
}) {
  return (
    <div className={size === 'lead' ? 'field field-lead' : 'field'}>
      <div className="field-head">
        <span className="field-name">{label}</span>
        {note ? <span className="field-note">{note}</span> : null}
      </div>
      <div className="field-value">{children}</div>
    </div>
  )
}

export function Subhead({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="subhead">
      {children}
      {note ? <span className="note">{note}</span> : null}
    </div>
  )
}

/** A value that has not arrived. Quiet on purpose, and it still carries the reason on hover. */
export function Placeholder({ reason }: { reason: string }) {
  return (
    <span className="placeholder" title={reason} aria-label={reason}>
      ····
    </span>
  )
}

/**
 * Renders a value that was read on chain, or the reason it could not be read. Nothing here ever falls back to
 * a placeholder number: unavailable is a legitimate state while the position is still being created.
 */
export function Show<T>({ result, children }: { result: Result<T>; children: (value: T) => ReactNode }) {
  const stated = useContext(StatedReasons)
  if (result.ok) return <>{children(result.value)}</>
  if (stated.has(result.reason)) return <Placeholder reason={result.reason} />
  return (
    <>
      <span className="unavailable">unavailable</span>
      <span className="why">{result.reason}</span>
    </>
  )
}

/** The same reason handling as `Show`, for the places where the value is not a `Result`. */
export function Missing({ reason }: { reason: string }) {
  const stated = useContext(StatedReasons)
  if (stated.has(reason)) return <Placeholder reason={reason} />
  return (
    <>
      <span className="unavailable">unavailable</span>
      <span className="why">{reason}</span>
    </>
  )
}

export function Addr({ value }: { value: string }) {
  return (
    <a className="mono" href={addressUrl(value)} target="_blank" rel="noreferrer" title={value}>
      {shortAddress(value)}
    </a>
  )
}

export function TxLink({ hash }: { hash: string }) {
  return (
    <a className="mono" href={txUrl(hash)} target="_blank" rel="noreferrer" title={hash}>
      {shortHash(hash)}
    </a>
  )
}

/** A unit or a qualifier, on its own line under the number, so it never pushes the digits out of the column. */
export function Unit({ children }: { children: ReactNode }) {
  return <span className="unit">{children}</span>
}

export function Num({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="num" title={title}>
      {children}
    </span>
  )
}
