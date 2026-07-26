import { formatUnits } from 'viem'

/** A value that was read, or a stated reason why it could not be. Nothing in this app invents a number. */
export type Result<T> = { ok: true; value: T } | { ok: false; reason: string }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const unavailable = <T>(reason: string): Result<T> => ({ ok: false, reason })

export function reason(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0]
  return String(error)
}

export const EXPLORER = 'https://sepolia.etherscan.io'
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`
export const tokenUrl = (address: string) => `${EXPLORER}/token/${address}`

/**
 * One numeric rule, applied everywhere.
 *
 * A narrow no-break space groups the thousands: narrow because a comma reads badly next to hex, no-break
 * because a wrapped number is unreadable and the columns here are narrow enough for it to happen.
 */
const GROUP = '\u202f'
/** Fixed, so every column of numbers on the page has its decimal point in the same place. */
export const DECIMALS_SHOWN = 2

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP)
}

/**
 * A token amount, truncated rather than rounded, so a figure on screen is never larger than the chain's.
 *
 * A non zero amount that would print as zero is shown as a bound instead, because "0.00" next to a balance
 * that exists is a lie and dust is a real state on a testnet.
 */
export function amount(value: bigint, decimals = 18, places = DECIMALS_SHOWN): string {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const sign = negative ? '-' : ''
  const scale = 10n ** BigInt(decimals)
  const factor = 10n ** BigInt(places)
  const scaled = (magnitude * factor) / scale
  if (magnitude > 0n && scaled === 0n) return `${sign}<${GROUP}0.${'0'.repeat(Math.max(0, places - 1))}1`
  const whole = group((scaled / factor).toString())
  if (places === 0) return `${sign}${whole}`
  return `${sign}${whole}.${(scaled % factor).toString().padStart(places, '0')}`
}

/** The same amount at full precision, for the places where the exact figure is the point. */
export function exact(value: bigint, decimals = 18): string {
  const raw = formatUnits(value, decimals)
  const [whole, fraction] = raw.split('.')
  return fraction ? `${group(whole)}.${fraction}` : group(whole)
}

/** Raw integers, grouped. Used for liquidity and block numbers, which are not denominated in a token. */
export function integer(value: bigint | number): string {
  return group(value.toString())
}

export function bps(value: number): string {
  return `${value} bps, ${(value / 100).toFixed(2)} percent`
}

export function ago(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
}

/**
 * Two truncation rules and no third one.
 *
 * An address is 20 bytes and a hash is 32, and telling them apart at a glance is worth more than saving four
 * characters, so they are cut to different lengths. Every call site uses one of these two.
 */
export function shortAddress(value: string): string {
  if (value.length <= 12) return value
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

export function shortHash(value: string): string {
  if (value.length <= 20) return value
  return `${value.slice(0, 10)}…${value.slice(-8)}`
}

/** JSON that survives bigints, used by the network panel and the raw payload views. */
export function stringify(value: unknown, indent = 2): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item.toString()}n` : item), indent)
}
