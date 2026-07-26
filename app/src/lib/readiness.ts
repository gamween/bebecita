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

export type Phase = 'loading' | 'ready' | 'failed'

export interface Readiness {
  phase: Phase
  /** Reasons hoisted out of the fields, most widespread first. */
  stated: Array<{ reason: string; fields: number }>
  /** The same reasons, for `Show` to recognise. */
  statedSet: ReadonlySet<string>
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

export function readinessOf(snapshot: unknown, error: string | null): Readiness {
  if (error) {
    return {
      phase: 'failed',
      stated: [{ reason: error, fields: 0 }, { reason: NOT_READ_YET, fields: 0 }],
      statedSet: new Set([error, NOT_READ_YET]),
    }
  }
  if (!snapshot) {
    return {
      phase: 'loading',
      stated: [],
      statedSet: new Set([NOT_READ_YET]),
    }
  }

  const counted = new Map<string, number>()
  collect(snapshot, counted)
  const stated = [...counted.entries()]
    .filter(([, fields]) => fields >= HOIST_AT)
    .sort((left, right) => right[1] - left[1])
    .map(([reason, fields]) => ({ reason, fields }))

  return {
    phase: 'ready',
    stated,
    statedSet: new Set([...stated.map((entry) => entry.reason), NOT_READ_YET]),
  }
}
