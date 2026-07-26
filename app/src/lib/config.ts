import type { Address, Hex } from 'viem'

/**
 * Addresses are never written down twice. `deployments/sepolia.json` is produced by the Foundry deploy script
 * and extended by the setup script, `deployments/chain.json` is lifted out of `solver/src/config.ts` by the
 * dev server. Both are fetched at runtime, so a redeploy or a freshly created position shows up on a refresh.
 */

export interface OrderRecord {
  maker: Address
  traits: string | number
  data: Hex
}

/** What `yarn aqua` and `yarn demo:reset` write, and what `yarn fill` reads back. */
export interface StrategyRecord {
  orderHash?: Hex
  salt?: Hex
  shipped?: { token0?: string; token1?: string }
  reachableAtShip?: string
  haircutBps?: number
  maxUnwindPct?: number
  unitsPerLiquidityE18?: string
  order?: OrderRecord
  shipTx?: Hex
}

/** The receipt of the last fill, as the fill script recorded it after reading it back from the chain. */
export interface FillRecord {
  txHash?: Hex
  orderHash?: Hex
  amountIn?: string
  amountOut?: string
  tokenIn?: Address
  tokenOut?: Address
  unwindPercent?: number
  gasUsed?: string
  blockNumber?: string
}

export interface DeploymentRecord {
  chainId?: number
  aqua?: Address
  positionManager?: Address
  poolManager?: Address
  router?: Address
  vault?: Address
  tokenA?: Address
  tokenB?: Address
  deployer?: Address

  pool?: {
    currency0?: Address
    currency1?: Address
    fee?: number
    tickSpacing?: number
    hooks?: Address
    poolId?: Hex
    tickLower?: number
    tickUpper?: number
  }
  /** Written by `yarn setup` once the Uniswap position exists. */
  position?: { tokenId?: string | number; liquidity?: string; owner?: Address }
  strategy?: StrategyRecord
  lastFill?: FillRecord

  /**
   * Flat forms of the three fields above, for a hand written record only.
   *
   * Nothing in the pipeline writes these: `yarn setup` nests the position, `yarn aqua` and `yarn demo:reset`
   * nest the strategy, and the checked in `deployments/sepolia.json` has neither key. They are kept because
   * the record is a plain JSON file a judge is invited to point at their own deployment, and reading both
   * shapes costs three lines where guessing wrong costs a dead button on a page whose whole job is to show
   * that the chain agrees with the record.
   *
   * A fourth flat field, `takerTraitsAndData`, used to sit here and be passed to `quote()` verbatim when
   * present. It was removed rather than documented: the taker traits carry the direction flag, so a stale blob
   * silently overrode the direction toggle on the page and quoted the opposite side of the book. The traits
   * are built per call by the port in `solver/src/takerTraits.ts`, which is the only thing a fill uses either.
   */
  tokenId?: string | number
  strategyHash?: Hex
  strategyHashes?: Hex[]
  order?: OrderRecord
}

export interface ChainRecord {
  chainId?: number
  aqua?: Address
  officialRouter?: Address
  poolManager?: Address
  positionManager?: Address
  stateView?: Address
  v4Quoter?: Address
  universalRouter?: Address
  permit2?: Address
  weth?: Address
}

export interface AppConfig {
  deployment: DeploymentRecord
  chain: ChainRecord
  /** Problems loading either file, surfaced instead of being swallowed. */
  problems: string[]
  loadedAt: number
}

async function fetchJson<T>(path: string, problems: string[]): Promise<T> {
  try {
    const response = await fetch(path, { cache: 'no-store' })
    if (!response.ok) {
      problems.push(`${path} returned ${response.status}`)
      return {} as T
    }
    return (await response.json()) as T
  } catch (error) {
    problems.push(`${path} could not be read: ${(error as Error).message}`)
    return {} as T
  }
}

export async function loadConfig(): Promise<AppConfig> {
  const problems: string[] = []
  const [deployment, chain] = await Promise.all([
    fetchJson<DeploymentRecord>('/deployments/sepolia.json', problems),
    fetchJson<ChainRecord>('/deployments/chain.json', problems),
  ])
  return { deployment, chain, problems, loadedAt: Date.now() }
}

/**
 * Every strategy hash the record carries, most recent first.
 *
 * The record only ever names the live one, because `yarn demo:reset` overwrites it. The dashboard finds the
 * others on chain, from the vault's own `Shipped` events, and this is the seed that guarantees the current one
 * is listed even when the log scan cannot reach back far enough.
 */
export function strategyHashes(deployment: DeploymentRecord): Hex[] {
  const hashes: Hex[] = []
  const add = (hash: Hex | undefined) => {
    if (hash && !hashes.some((known) => known.toLowerCase() === hash.toLowerCase())) hashes.push(hash)
  }
  add(deployment.strategy?.orderHash)
  add(deployment.strategyHash)
  for (const hash of deployment.strategyHashes ?? []) add(hash)
  return hashes
}

/** The tokenId written by the setup script, if any. The vault's own immutable is preferred over this. */
export function declaredTokenId(deployment: DeploymentRecord): bigint | null {
  const declared = deployment.position?.tokenId ?? deployment.tokenId
  if (declared === undefined || declared === null || declared === '') return null
  try {
    const value = BigInt(declared)
    return value > 0n ? value : null
  } catch {
    return null
  }
}

/** The order the book quotes on, nested under `strategy` by `yarn aqua` and flat in older records. */
export function orderRecord(deployment: DeploymentRecord): OrderRecord | null {
  return deployment.order ?? deployment.strategy?.order ?? null
}
