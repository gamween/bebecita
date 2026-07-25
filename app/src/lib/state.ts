import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem'

import { aquaAbi, erc20Abi, positionManagerAbi, routerAbi, stateViewAbi, vaultAbi } from './abi'
import { publicClient } from './client'
import { declaredTokenId, strategyHashes, type AppConfig } from './config'
import { ok, reason, short, unavailable, type Result } from './format'

export interface PoolKey {
  currency0: Address
  currency1: Address
  fee: number
  tickSpacing: number
  hooks: Address
}

export interface TokenMeta {
  address: Address
  symbol: Result<string>
  decimals: Result<number>
}

export interface StrategyRow {
  hash: Hex
  balances: Array<{ token: Address; symbol: string; raw: Result<{ balance: bigint; tokensCount: number }> }>
}

export interface Snapshot {
  at: number
  blockNumber: Result<bigint>
  tokenA: TokenMeta
  tokenB: TokenMeta

  uniswap: {
    tokenId: bigint | null
    tokenIdSource: 'vault immutable' | 'deployments/sepolia.json' | null
    positionOwner: Result<Address>
    liquidity: Result<bigint>
    poolKey: Result<PoolKey>
    poolId: Hex | null
    tick: Result<number>
    sqrtPriceX96: Result<bigint>
    lpFee: Result<number>
    poolLiquidity: Result<bigint>
    tickLower: Result<number>
    tickUpper: Result<number>
    stateView: Address | null
  }

  vault: {
    address: Address
    owner: Result<Address>
    floatA: Result<bigint>
    floatB: Result<bigint>
    reserves: Result<[bigint, bigint]>
    effectiveLiquidity: Result<[bigint, bigint]>
    reachable: Result<bigint>
    maxUnwindPct: Result<number>
    haircutBps: Result<number>
    unitsPerLiquidityE18: Result<bigint>
    /** The key handed to the URC-3 accessors, and whether it came from the position or was constructed. */
    keyUsed: PoolKey
    keyFromPosition: boolean
  }

  aqua: {
    address: Result<Address>
    routerAqua: Result<Address>
    opcode: Result<bigint>
    app: Address | null
    strategies: StrategyRow[]
  }
}

const ZERO = '0x0000000000000000000000000000000000000000' as const

type MulticallItem = { status: 'success'; result: unknown } | { status: 'failure'; error: Error }

function pick<T>(items: MulticallItem[] | undefined, index: number, label: string): Result<T> {
  const item = items?.[index]
  if (!item) return unavailable(`${label} was not read`)
  if (item.status === 'failure') return unavailable(`${label}: ${reason(item.error)}`)
  return ok(item.result as T)
}

/** int24 comes back as a JS number already sign extended by viem, this only guards the raw packed decode. */
function toInt24(bits: bigint): number {
  const value = Number(bits & 0xffffffn)
  return value >= 0x800000 ? value - 0x1000000 : value
}

export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'currency0', type: 'address' },
            { name: 'currency1', type: 'address' },
            { name: 'fee', type: 'uint24' },
            { name: 'tickSpacing', type: 'int24' },
            { name: 'hooks', type: 'address' },
          ],
        },
      ],
      [key],
    ),
  )
}

/** The symbol and decimals of either demo token, by address, for labelling anything sorted as token0/token1. */
export function tokenOf(snapshot: Snapshot, address: Address): { symbol: string; decimals: number } {
  const meta = address.toLowerCase() === snapshot.tokenA.address.toLowerCase() ? snapshot.tokenA : snapshot.tokenB
  return {
    symbol: meta.symbol.ok ? meta.symbol.value : short(meta.address),
    decimals: meta.decimals.ok ? meta.decimals.value : 18,
  }
}

/**
 * Reads the whole dashboard.
 *
 * Everything here is a live call against Sepolia. A field that cannot be read carries the reason it could not
 * be read, because the position may legitimately not exist yet while the setup script is still running.
 *
 * `strategyHashes` are the ones found on chain, from the vault's `Shipped` events. They are merged with the one
 * the deployment record names, because the record only ever names the live one and the metric this dashboard
 * leads with is a sum over all of them.
 */
export async function readSnapshot(config: AppConfig, extraStrategyHashes: Hex[] = []): Promise<Snapshot> {
  const { deployment, chain } = config
  const vault = deployment.vault
  const router = deployment.router
  const tokenAAddress = deployment.tokenA
  const tokenBAddress = deployment.tokenB
  const positionManager = deployment.positionManager ?? chain.positionManager ?? null
  const stateView = chain.stateView ?? null

  if (!vault || !router || !tokenAAddress || !tokenBAddress) {
    throw new Error('deployments/sepolia.json is missing the vault, router or token addresses')
  }

  const vaultContract = { address: vault, abi: vaultAbi } as const
  const routerContract = { address: router, abi: routerAbi } as const

  const [blockNumber, base] = await Promise.all([
    publicClient
      .getBlockNumber()
      .then((value) => ok(value))
      .catch((error) => unavailable<bigint>(reason(error))),
    publicClient.multicall({
      allowFailure: true,
      contracts: [
        { ...vaultContract, functionName: 'AQUA' },
        { ...vaultContract, functionName: 'ROUTER' },
        { ...vaultContract, functionName: 'POSITION_MANAGER' },
        { ...vaultContract, functionName: 'TOKEN_ID' },
        { ...vaultContract, functionName: 'OWNER' },
        { ...vaultContract, functionName: 'maxUnwindPct' },
        { ...vaultContract, functionName: 'haircutBps' },
        { ...vaultContract, functionName: 'unitsPerLiquidityE18' },
        { ...vaultContract, functionName: 'reachableFromPosition' },
        { ...routerContract, functionName: 'AQUA' },
        { ...routerContract, functionName: 'OPCODE_UNWIND_PRICED_BALANCE_OUT' },
        { address: tokenAAddress, abi: erc20Abi, functionName: 'symbol' },
        { address: tokenAAddress, abi: erc20Abi, functionName: 'decimals' },
        { address: tokenAAddress, abi: erc20Abi, functionName: 'balanceOf', args: [vault] },
        { address: tokenBAddress, abi: erc20Abi, functionName: 'symbol' },
        { address: tokenBAddress, abi: erc20Abi, functionName: 'decimals' },
        { address: tokenBAddress, abi: erc20Abi, functionName: 'balanceOf', args: [vault] },
      ],
    }) as Promise<MulticallItem[]>,
  ])

  const vaultAqua = pick<Address>(base, 0, 'vault.AQUA')
  const vaultPositionManager = pick<Address>(base, 2, 'vault.POSITION_MANAGER')
  const vaultTokenId = pick<bigint>(base, 3, 'vault.TOKEN_ID')

  const tokenA: TokenMeta = {
    address: tokenAAddress,
    symbol: pick<string>(base, 11, 'tokenA.symbol'),
    decimals: pick<number>(base, 12, 'tokenA.decimals'),
  }
  const tokenB: TokenMeta = {
    address: tokenBAddress,
    symbol: pick<string>(base, 14, 'tokenB.symbol'),
    decimals: pick<number>(base, 15, 'tokenB.decimals'),
  }

  // The vault's immutable is the truth about which position backs the book. The deployment record is only a
  // fallback, for the window where the position exists but the vault was deployed before it.
  const fromVault = vaultTokenId.ok && vaultTokenId.value > 0n ? vaultTokenId.value : null
  const fromFile = declaredTokenId(deployment)
  const tokenId = fromVault ?? fromFile
  const tokenIdSource = fromVault ? 'vault immutable' : fromFile ? 'deployments/sepolia.json' : null

  const pmAddress = (vaultPositionManager.ok ? vaultPositionManager.value : positionManager) as Address | null

  let position: MulticallItem[] | undefined
  if (tokenId !== null && pmAddress) {
    position = (await publicClient.multicall({
      allowFailure: true,
      contracts: [
        { address: pmAddress, abi: positionManagerAbi, functionName: 'getPositionLiquidity', args: [tokenId] },
        { address: pmAddress, abi: positionManagerAbi, functionName: 'getPoolAndPositionInfo', args: [tokenId] },
        { address: pmAddress, abi: positionManagerAbi, functionName: 'ownerOf', args: [tokenId] },
      ],
    })) as MulticallItem[]
  }

  const missingPosition =
    tokenId === null ? 'no position yet, the vault carries tokenId 0' : 'the position manager did not answer'

  const liquidity = position ? pick<bigint>(position, 0, 'getPositionLiquidity') : unavailable<bigint>(missingPosition)
  const poolAndInfo = position
    ? pick<[PoolKey, bigint]>(position, 1, 'getPoolAndPositionInfo')
    : unavailable<[PoolKey, bigint]>(missingPosition)
  const positionOwner = position ? pick<Address>(position, 2, 'ownerOf') : unavailable<Address>(missingPosition)

  const poolKey: Result<PoolKey> = poolAndInfo.ok ? ok(poolAndInfo.value[0]) : poolAndInfo
  const info = poolAndInfo.ok ? poolAndInfo.value[1] : null
  const tickLower: Result<number> = info === null ? unavailable(missingPosition) : ok(toInt24(info >> 8n))
  const tickUpper: Result<number> = info === null ? unavailable(missingPosition) : ok(toInt24(info >> 32n))

  // URC-3 only reads the two currencies off the key, so the accessors still answer honestly before the pool
  // exists. When that happens the app says the key was constructed rather than read from the position.
  const keyFromPosition = poolKey.ok && poolKey.value.currency0 !== ZERO
  const sorted = [tokenAAddress, tokenBAddress].sort((left, right) =>
    left.toLowerCase() < right.toLowerCase() ? -1 : 1,
  ) as [Address, Address]
  const keyUsed: PoolKey = keyFromPosition
    ? (poolKey as { ok: true; value: PoolKey }).value
    : { currency0: sorted[0], currency1: sorted[1], fee: 3000, tickSpacing: 60, hooks: ZERO }

  const poolId = keyFromPosition ? poolIdOf(keyUsed) : null

  const urc3Contracts = [
    { ...vaultContract, functionName: 'getReserves' as const, args: [keyUsed] },
    { ...vaultContract, functionName: 'getEffectiveLiquidity' as const, args: [keyUsed] },
  ]
  const poolContracts =
    poolId && stateView
      ? [
          { address: stateView, abi: stateViewAbi, functionName: 'getSlot0' as const, args: [poolId] },
          { address: stateView, abi: stateViewAbi, functionName: 'getLiquidity' as const, args: [poolId] },
        ]
      : []

  const derived = (await publicClient.multicall({
    allowFailure: true,
    contracts: [...urc3Contracts, ...poolContracts] as never,
  })) as MulticallItem[]

  const noStateView = !stateView
    ? 'stateView address missing from solver/src/config.ts'
    : 'needs a live position, the pool id comes from its key'
  const slot0 = poolContracts.length
    ? pick<[bigint, number, number, number]>(derived, 2, 'StateView.getSlot0')
    : unavailable<[bigint, number, number, number]>(noStateView)
  const poolLiquidity = poolContracts.length
    ? pick<bigint>(derived, 3, 'StateView.getLiquidity')
    : unavailable<bigint>(noStateView)

  const aquaAddress: Result<Address> = vaultAqua.ok
    ? vaultAqua
    : deployment.aqua
      ? ok(deployment.aqua)
      : unavailable('no Aqua address on the vault or in the deployment record')

  const seen = new Set<string>()
  const hashes = [...strategyHashes(deployment), ...extraStrategyHashes].filter((hash) => {
    const key = hash.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const strategies: StrategyRow[] = []
  if (aquaAddress.ok && hashes.length) {
    const tokens: Array<{ address: Address; symbol: string }> = [
      { address: tokenAAddress, symbol: tokenA.symbol.ok ? tokenA.symbol.value : 'token A' },
      { address: tokenBAddress, symbol: tokenB.symbol.ok ? tokenB.symbol.value : 'token B' },
    ]
    const calls = hashes.flatMap((hash) =>
      tokens.map((token) => ({
        address: aquaAddress.value,
        abi: aquaAbi,
        functionName: 'rawBalances' as const,
        args: [vault, router, hash, token.address] as const,
      })),
    )
    const raw = (await publicClient.multicall({ allowFailure: true, contracts: calls as never })) as MulticallItem[]
    hashes.forEach((hash, hashIndex) => {
      strategies.push({
        hash,
        balances: tokens.map((token, tokenIndex) => {
          const item = pick<[bigint, number]>(raw, hashIndex * tokens.length + tokenIndex, 'Aqua.rawBalances')
          return {
            token: token.address,
            symbol: token.symbol,
            raw: item.ok ? ok({ balance: item.value[0], tokensCount: item.value[1] }) : item,
          }
        }),
      })
    })
  }

  return {
    at: Date.now(),
    blockNumber,
    tokenA,
    tokenB,
    uniswap: {
      tokenId,
      tokenIdSource,
      positionOwner,
      liquidity,
      poolKey,
      poolId,
      tick: slot0.ok ? ok(slot0.value[1]) : slot0,
      sqrtPriceX96: slot0.ok ? ok(slot0.value[0]) : slot0,
      lpFee: slot0.ok ? ok(slot0.value[3]) : slot0,
      poolLiquidity,
      tickLower,
      tickUpper,
      stateView,
    },
    vault: {
      address: vault,
      owner: pick<Address>(base, 4, 'vault.OWNER'),
      floatA: pick<bigint>(base, 13, 'tokenA.balanceOf(vault)'),
      floatB: pick<bigint>(base, 16, 'tokenB.balanceOf(vault)'),
      reserves: pick<[bigint, bigint]>(derived, 0, 'vault.getReserves'),
      effectiveLiquidity: pick<[bigint, bigint]>(derived, 1, 'vault.getEffectiveLiquidity'),
      reachable: pick<bigint>(base, 8, 'vault.reachableFromPosition'),
      maxUnwindPct: pick<number>(base, 5, 'vault.maxUnwindPct'),
      haircutBps: pick<number>(base, 6, 'vault.haircutBps'),
      unitsPerLiquidityE18: pick<bigint>(base, 7, 'vault.unitsPerLiquidityE18'),
      keyUsed,
      keyFromPosition,
    },
    aqua: {
      address: aquaAddress,
      routerAqua: pick<Address>(base, 9, 'router.AQUA'),
      opcode: pick<bigint>(base, 10, 'router.OPCODE_UNWIND_PRICED_BALANCE_OUT'),
      app: router,
      strategies,
    },
  }
}
