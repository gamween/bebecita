import { ok, unavailable, type Result } from './format'
import type { Snapshot } from './state'

/**
 * SLAC, the Shared Liquidity Amplification Coefficient.
 *
 * 1inch defines it on page 4 of the Aqua whitepaper as the ratio of the total liquidity a maker has
 * provisioned across all of its strategies to the wallet equity actually backing it. It is their metric, not
 * ours, and it is the cleanest way to say what this project does, because the numerator is exactly what Aqua
 * stores and the denominator is exactly what Aqua declines to check.
 *
 * It is computed twice here, against two different denominators, because the interesting thing about this
 * maker is that the obvious denominator breaks:
 *
 *   against bare wallet equity     the vault's plain ERC20 balances, which are almost nothing, because the
 *                                  inventory is inside a Uniswap position rather than in the wallet. The ratio
 *                                  is enormous, and undefined when the vault holds literally nothing. That is
 *                                  the reading a solvency checker would take, and it is why a solvency checker
 *                                  would refuse this maker.
 *
 *   against reachable equity       free float plus `vault.reachableFromPosition()`, which is the figure
 *                                  instruction 0x92 computes on chain and clamps the quote to. Finite, and the
 *                                  one that describes what the book can actually settle.
 *
 * The numerator sums both tokens across every strategy, in token units. Both demo tokens carry 18 decimals, so
 * the sum is a count of tokens rather than a valuation, and the two denominators are summed the same way.
 * `reachableFromPosition` is added once and not once per token: one fill leans on the position once, whichever
 * side it happens to pay out.
 */

export interface SlacNumerator {
  total: bigint
  strategies: number
  /** Balances read, and balances that could not be. A partial numerator is stated, never silently rounded. */
  read: number
  missing: number
}

export interface SlacLeg {
  denominator: Result<bigint>
  /** The ratio itself. Unavailable carries the reason, which for a bare wallet is usually a zero denominator. */
  ratio: Result<number>
}

export interface Slac {
  numerator: Result<SlacNumerator>
  bare: SlacLeg
  reachable: SlacLeg
}

const WAD = 10n ** 18n
/** Six decimals of ratio, which is more than any of these numbers deserves and keeps the bigint math exact. */
const SCALE = 1_000_000n

function ratioOf(numerator: Result<SlacNumerator>, denominator: Result<bigint>): Result<number> {
  if (!numerator.ok) return unavailable(numerator.reason)
  if (!denominator.ok) return unavailable(denominator.reason)
  if (denominator.value === 0n) {
    return unavailable(
      'undefined, the denominator is zero: the vault holds no free tokens at all, so there is no wallet equity to divide by',
    )
  }
  return ok(Number((numerator.value.total * SCALE) / denominator.value) / Number(SCALE))
}

function sum(...values: Result<bigint>[]): Result<bigint> {
  let total = 0n
  for (const value of values) {
    if (!value.ok) return value
    total += value.value
  }
  return ok(total)
}

/** Both readings, from one snapshot. Nothing here reads the chain: the snapshot already did. */
export function slacOf(snapshot: Snapshot | null): Slac {
  if (!snapshot) {
    const pending = unavailable<never>('not read yet')
    return { numerator: pending, bare: { denominator: pending, ratio: pending }, reachable: { denominator: pending, ratio: pending } }
  }

  let total = 0n
  let read = 0
  let missing = 0
  for (const strategy of snapshot.aqua.strategies) {
    for (const balance of strategy.balances) {
      if (balance.raw.ok) {
        total += balance.raw.value.balance
        read += 1
      } else {
        missing += 1
      }
    }
  }

  const numerator: Result<SlacNumerator> = snapshot.aqua.strategies.length
    ? read === 0
      ? unavailable(`none of the ${missing} raw balances could be read from Aqua`)
      : ok({ total, strategies: snapshot.aqua.strategies.length, read, missing })
    : unavailable('no strategy found for this maker, so nothing has been provisioned to divide')

  const float = sum(snapshot.vault.floatA, snapshot.vault.floatB)
  const bare: SlacLeg = { denominator: float, ratio: ratioOf(numerator, float) }

  const reachableDenominator = sum(float, snapshot.vault.reachable)
  const reachable: SlacLeg = {
    denominator: reachableDenominator,
    ratio: ratioOf(numerator, reachableDenominator),
  }

  return { numerator, bare, reachable }
}

/** Whole tokens, from an 18 decimal sum, for the two denominators and the numerator alike. */
export const tokens = (value: bigint): number => Number((value * SCALE) / WAD) / Number(SCALE)

/**
 * A ratio, rendered at a precision that matches its size. A SLAC of 227 does not need four decimals and a
 * SLAC of 3.2 does not survive being rounded to an integer.
 */
export function ratio(value: number): string {
  if (!Number.isFinite(value)) return 'undefined'
  if (value >= 1000) return `${Math.round(value).toLocaleString('en-US').replace(/,/g, ' ')}x`
  if (value >= 10) return `${value.toFixed(1)}x`
  return `${value.toFixed(2)}x`
}
