/**
 * The parameters both Uniswap LP clients send, declared once.
 *
 * There are two clients and there is one client: `solver/src/uniswap.ts` calls
 * `https://liquidity.api.uniswap.org` directly with an `x-api-key` header, and `app/src/lib/uniswap.ts` calls
 * the same operations through the `/api/uniswap` proxy that attaches the key server side. The transport
 * differs on purpose, because a browser cannot be trusted with the key. The request bodies must not, because
 * the whole claim of this project is that the tab and the terminal run the same fill: a preview built with a
 * different tolerance than the fill would use is a preview of a different operation.
 *
 * So the transports stay separate and everything that shapes a request lives here, where a change is one edit
 * and a drift between the two is visible as a diff rather than as a number that quietly stopped matching.
 *
 * Constants only, no imports, so `app/src/lib/uniswap.ts` can read it through the `@solver` alias the same way
 * `app/src/lib/fill.ts` reads `fillPlan.ts`.
 */

/**
 * Slippage tolerance, in percent, on `/lp/create`, `/lp/decrease` and `/lp/increase`.
 *
 * 0.5 and not more, on both sides. These payloads are executed inside a fill, one instruction apart, and the
 * vault's guards are exact: a decrease that settles below what the API quoted trips the floor check on the
 * realised delta, and an increase that settles above what the vault holds reverts inside Permit2. A wide
 * tolerance does not make either of those succeed. All it does is widen the band the position can be moved
 * through by whatever else lands in the block, and this pool's only liquidity provider is the vault itself,
 * so that band is the maker's own money.
 *
 * The browser used to send 5 on `/lp/increase` while the terminal sent 0.5, under a comment on the neighbouring
 * call claiming both used the same number.
 */
export const LP_SLIPPAGE_TOLERANCE_PCT = 0.5

/**
 * `simulateTransaction` on every LP call.
 *
 * False, always. A simulation runs against the caller's current state, and every payload this project asks for
 * is going to be executed by the vault inside a swap that has not happened yet, so the simulation would fail
 * for a reason that has nothing to do with the payload. The gas estimate it buys is not used by anything here.
 */
export const LP_SIMULATE_TRANSACTION = false
