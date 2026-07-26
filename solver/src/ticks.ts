/**
 * The range this project's position is opened on, in one place.
 *
 * Full range, which is a deliberate choice and not laziness. At full range a unit of v4 liquidity is worth one
 * unit of each token to within rounding, so the maker's `unitsPerLiquidityE18` of 1e18 is an honest conversion
 * factor rather than a tuned one, and the position can never fall out of range and stop being reachable mid
 * demo.
 *
 * `-887220` and `887220` are the extreme ticks rounded to a multiple of 60, the canonical spacing of the 0.30%
 * tier. `yarn setup` opens the position with them and the dashboard decides whether a position it read is full
 * range by comparing against them, which is the same number doing two jobs and therefore one constant.
 *
 * No imports, so `app/src/pages/Dashboard.tsx` can read it through the `@solver` alias.
 */
export const FULL_RANGE_TICK_LOWER = -887220
export const FULL_RANGE_TICK_UPPER = 887220
