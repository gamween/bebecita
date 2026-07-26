/**
 * The one piece of arithmetic a two sided deposit cannot be written without, in one place.
 *
 * `/lp/increase` names one token and one amount, and the API computes the other leg from live pool state. So
 * the caller has to decide which token names the deposit, and getting that wrong is not a rounding error: the
 * API answers with a leg the vault does not hold, the position manager pulls it through Permit2, and the whole
 * transaction reverts. Inside a fill that is the fill reverting, which is why this lives next to the sizing
 * rather than inside either caller.
 *
 * Pure arithmetic on bigints, no chain and no network, because `solver/src/fillPlan.ts` imports it and the
 * browser imports that through the `@solver` alias.
 */

/**
 * One side of a prospective two sided deposit: the token, what the depositor will hold, and what the pool
 * holds of it.
 *
 * `reserve` only ever appears in a ratio against the other side's, so any pair of numbers in the pool's own
 * proportion works: the position's reserves computed from liquidity and `sqrtPriceX96`, or the two amounts a
 * pro rata `/lp/decrease` reports, which are the same ratio measured by the API itself.
 */
export interface DepositSide<T> {
  token: T
  held: bigint
  reserve: bigint
}

/**
 * Which side runs out first, and therefore which one names the deposit.
 *
 * A deposit consumes the two tokens in the pool's ratio, so the binding side is the one whose holding is
 * smallest *relative to that ratio*: side A binds when `heldA / reserveA <= heldB / reserveB`, cross multiplied
 * here so it stays in integers.
 *
 * The comparison is deliberately not `min(heldA, heldB)`. A raw `min` across two different tokens compares raw
 * amounts of things that are not the same unit, and it is only ever right while the pool sits at parity, where
 * one of each token is worth the same. This pool starts at parity and every `yarn rebalance` moves it further
 * off, and once it is off, `min` names the wrong side roughly half the time: the API then computes a dependent
 * leg larger than the holder has, and the deposit reverts inside Permit2. The ratio is what matters, never the
 * bare number, so please do not simplify this back.
 */
export function bindingSide<T>(a: DepositSide<T>, b: DepositSide<T>): DepositSide<T> {
  // A side with nothing in the pool cannot anchor a ratio, so fall back to the raw comparison rather than
  // dividing by it. At full range this only happens if the position holds nothing at all.
  if (a.reserve === 0n || b.reserve === 0n) return a.held <= b.held ? a : b
  return a.held * b.reserve <= b.held * a.reserve ? a : b
}
