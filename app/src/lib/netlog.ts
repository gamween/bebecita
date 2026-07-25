/**
 * The network log behind the panel at the bottom of the app.
 *
 * An API integration has to be provable on screen, so every Uniswap call is recorded whole: the request body
 * that was sent, the status, the response body that came back, and the `x-ratelimit-remaining` header, which
 * is the value that proves the key is real and that the request left the machine.
 */

export interface NetEntry {
  id: number
  label: string
  method: string
  /** Path this app called. In dev it is the proxy path, and `upstream` carries the address it reached. */
  url: string
  upstream: string | null
  apiKeyAttached: boolean | null
  request: unknown
  startedAt: number
  durationMs: number | null
  status: number | null
  response: unknown
  error: string | null
  rateLimitRemaining: string | null
  responseHeaders: Record<string, string>
}

type Listener = () => void

let sequence = 0
let entries: NetEntry[] = []
const listeners = new Set<Listener>()

function emit(): void {
  entries = [...entries]
  for (const listener of listeners) listener()
}

export const netlog = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  snapshot(): NetEntry[] {
    return entries
  },
  clear(): void {
    entries = []
    emit()
  },
  start(label: string, method: string, url: string, request: unknown): number {
    const id = ++sequence
    entries = [
      {
        id,
        label,
        method,
        url,
        upstream: null,
        apiKeyAttached: null,
        request,
        startedAt: Date.now(),
        durationMs: null,
        status: null,
        response: null,
        error: null,
        rateLimitRemaining: null,
        responseHeaders: {},
      },
      ...entries,
    ].slice(0, 40)
    emit()
    return id
  },
  finish(id: number, patch: Partial<NetEntry>): void {
    entries = entries.map((entry) =>
      entry.id === id ? { ...entry, ...patch, durationMs: Date.now() - entry.startedAt } : entry,
    )
    emit()
  },
}

/** Last rate limit value seen on any call, shown in the panel header. */
export function lastRateLimitRemaining(list: NetEntry[]): string | null {
  for (const entry of list) if (entry.rateLimitRemaining) return entry.rateLimitRemaining
  return null
}
