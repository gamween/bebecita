import type { Result } from './format'
import type { Snapshot } from './state'

/**
 * Whether the page is loading, ready, or broken, and which reasons belong at the top rather than on a field.
 *
 * Two states used to look identical here. A page that had not read anything yet and a page whose reads had
 * failed both printed the same twenty five copies of "unavailable, not read yet", which reads as twenty five
 * broken fields. A reason that covers several fields is stated once, at the top, and those fields render as
 * quiet placeholders under it.
 */

/** How many fields a single reason has to cover before it is worth saying at the top instead of on each one. */
const HOIST_AT = 3

export const NOT_READ_YET = 'not read yet'

export type Phase = 'loading' | 'ready' | 'degraded' | 'failed'

export interface Readiness {
  phase: Phase
  /** Reasons hoisted out of the fields, most widespread first. */
  stated: Array<{ reason: string; fields: number }>
  /** The same reasons, for `Show` to recognise. */
  statedSet: ReadonlySet<string>
  /** The reads the page leads with that did not answer. Non empty exactly when the phase is degraded. */
  broken: Array<{ what: string; reason: string }>
}

/**
 * The reads that have to answer before this page can be called ready.
 *
 * `readSnapshot` asks for everything with `allowFailure`, and it only throws when an address is missing, so an
 * unreachable StateView or a vault call that reverted still returns a snapshot. Ready for any snapshot at all
 * therefore meant a green light over a page that could not show the numbers it exists to show.
 */
function brokenSpine(snapshot: Snapshot): Array<{ what: string; reason: string }> {
  const spine: Array<[string, Result<unknown>]> = [
    ['the block number', snapshot.blockNumber],
    ['pool state through StateView', snapshot.uniswap.tick],
    ['URC-3 reserves', snapshot.vault.reserves],
    ['URC-3 effective liquidity', snapshot.vault.effectiveLiquidity],
    ['the router AQUA() getter', snapshot.aqua.routerAqua],
    ['the custom opcode getter', snapshot.aqua.opcode],
  ]
  return spine.flatMap(([what, result]) => (result.ok ? [] : [{ what, reason: result.reason }]))
}

/** Walks a snapshot and counts how many fields each unreadable reason accounts for. */
function collect(value: unknown, out: Map<string, number>, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 8) return
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out, depth + 1)
    return
  }
  const record = value as Record<string, unknown>
  if (record.ok === false && typeof record.reason === 'string') {
    out.set(record.reason, (out.get(record.reason) ?? 0) + 1)
    return
  }
  // A successful Result wraps a value, not more fields, so there is nothing to count inside it.
  if (record.ok === true) return
  for (const item of Object.values(record)) collect(item, out, depth + 1)
}

export function readinessOf(snapshot: Snapshot | null, error: string | null): Readiness {
  if (error) {
    return {
      phase: 'failed',
      stated: [{ reason: error, fields: 0 }, { reason: NOT_READ_YET, fields: 0 }],
      statedSet: new Set([error, NOT_READ_YET]),
      broken: [],
    }
  }
  if (!snapshot) {
    return {
      phase: 'loading',
      stated: [],
      statedSet: new Set([NOT_READ_YET]),
      broken: [],
    }
  }

  const counted = new Map<string, number>()
  collect(snapshot, counted)
  const stated = [...counted.entries()]
    .filter(([, fields]) => fields >= HOIST_AT)
    .sort((left, right) => right[1] - left[1])
    .map(([reason, fields]) => ({ reason, fields }))
  const broken = brokenSpine(snapshot)

  return {
    phase: broken.length ? 'degraded' : 'ready',
    stated,
    statedSet: new Set([...stated.map((entry) => entry.reason), NOT_READ_YET]),
    broken,
  }
}
