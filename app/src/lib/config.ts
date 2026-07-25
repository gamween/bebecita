import type { Address, Hex } from 'viem'

/**
 * Addresses are never written down twice. `deployments/sepolia.json` is produced by the Foundry deploy script
 * and extended by the setup script, `deployments/chain.json` is lifted out of `solver/src/config.ts` by the
 * dev server. Both are fetched at runtime, so a redeploy or a freshly created position shows up on a refresh.
 */

export interface DeploymentRecord {
  chainId?: number
  aqua?: Address
  positionManager?: Address
  router?: Address
  vault?: Address
  tokenA?: Address
  tokenB?: Address
  deployer?: Address

  /** Written once the Uniswap position exists. Absent while the position is still being created. */
  tokenId?: string | number
  /** The Aqua strategy the book quotes on. Either field may be present. */
  strategyHash?: Hex
  strategyHashes?: Hex[]
  /** The SwapVM order as shipped. `quote()` cannot be called without it. */
  order?: { maker: Address; traits: string | number; data: Hex }
  /** A taker traits blob published by the solver, used verbatim when present. */
  takerTraitsAndData?: Hex
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

/** Every strategy hash the record carries, in the order it declares them. */
export function strategyHashes(deployment: DeploymentRecord): Hex[] {
  const hashes = [...(deployment.strategyHashes ?? [])]
  if (deployment.strategyHash && !hashes.includes(deployment.strategyHash)) hashes.unshift(deployment.strategyHash)
  return hashes
}

/** The tokenId written by the setup script, if any. The vault's own immutable is preferred over this. */
export function declaredTokenId(deployment: DeploymentRecord): bigint | null {
  if (deployment.tokenId === undefined || deployment.tokenId === null || deployment.tokenId === '') return null
  try {
    const value = BigInt(deployment.tokenId)
    return value > 0n ? value : null
  } catch {
    return null
  }
}
