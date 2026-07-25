import { formatUnits, type Address, type Hex } from 'viem'

/** A value that was read, or a stated reason why it could not be. Nothing in this app invents a number. */
export type Result<T> = { ok: true; value: T } | { ok: false; reason: string }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const unavailable = <T>(reason: string): Result<T> => ({ ok: false, reason })

export function mapResult<T, U>(result: Result<T>, fn: (value: T) => U): Result<U> {
  return result.ok ? ok(fn(result.value)) : result
}

export function reason(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0]
  return String(error)
}

export const EXPLORER = 'https://sepolia.etherscan.io'
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`
export const tokenUrl = (address: string) => `${EXPLORER}/token/${address}`

export function short(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 2) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

/** Fixed point with a thin space every three digits, so long balances stay readable at a glance. */
export function amount(value: bigint, decimals = 18, precision = 4): string {
  const raw = formatUnits(value, decimals)
  const [whole, fraction = ''] = raw.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  if (precision === 0) return grouped
  const trimmed = fraction.slice(0, precision).replace(/0+$/, '')
  return trimmed ? `${grouped}.${trimmed}` : grouped
}

/** Raw integers, grouped. Used for liquidity, which is not denominated in a token. */
export function integer(value: bigint | number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

export function bps(value: number): string {
  return `${value} bps, ${(value / 100).toFixed(2)} percent`
}

export function ago(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s ago`
}

export function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

export function isHex(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)
}

/** JSON that survives bigints, used by the network panel and the raw payload views. */
export function stringify(value: unknown, indent = 2): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item.toString()}n` : item), indent)
}
