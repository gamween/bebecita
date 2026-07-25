/**
 * The shipped strategy, rebuilt from what `yarn aqua` recorded and proved against it.
 *
 * Both `yarn fill` and `yarn demo:reset` need the exact order the book quotes on, and neither may guess it.
 * The router looks Aqua balances up under `keccak256(abi.encode(order))`, so an order that differs by one byte
 * from the shipped one reverts inside Aqua with nothing in the revert data pointing at the encoding.
 *
 * So this module never trusts the stored blob on its own. It rebuilds the order from the stored parameters
 * using the builders `solver/src/aqua.ts` exports, and refuses to continue unless the rebuilt hash equals the
 * hash `yarn aqua` recorded. That single assertion proves the parameters, the salt, the program layout and the
 * traits at once, which is why the fill path can then treat them as facts.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { getAddress, keccak256, type Address, type Hex } from 'viem'

import {
  buildConcentrateArgs,
  buildOrder,
  buildProgram,
  buildUnwindArgs,
  encodeOrder,
  type Order,
} from './aqua.js'

const ROOT = resolve(import.meta.dirname, '../..')

/** Written by `yarn setup` and `yarn aqua`, read by everything else. */
export const DEPLOYMENTS_PATH = resolve(ROOT, 'deployments/sepolia.json')

/**
 * The handover file between the TypeScript sizing and the Foundry broadcast.
 *
 * It lives under `deployments/` because that is the one path `foundry.toml` grants `fs_permissions` on, and it
 * carries the `.local.json` suffix because `.gitignore` already excludes that pattern: this file holds calldata
 * built against a block that has already passed and is worthless the moment it is written.
 */
export const FILL_REQUEST_PATH = resolve(ROOT, 'deployments/fill.local.json')

/** Path as Foundry needs it, relative to the project root, which is where `forge script` runs. */
export const FILL_REQUEST_RELATIVE = 'deployments/fill.local.json'

export interface StrategyRecord {
  orderHash: Hex
  salt: Hex
  /** What the vault shipped into Aqua, asymmetric on purpose. See `shippedAmounts` in `aqua.ts`. */
  shipped: { token0: string; token1: string }
  reachableAtShip?: string
  haircutBps: number
  maxUnwindPct: number
  unitsPerLiquidityE18: string
  /** The two bounds of instruction `0x51`, in 1e18 fixed point. Part of the program bytes. */
  sqrtPriceMin: string
  sqrtPriceMax: string
  /** Where those two came from: the position's ticks and the pool state at ship time. Provenance, not input. */
  curve?: Record<string, unknown>
  order: { maker: string; traits: string; data: Hex }
  shipTx?: Hex
}

export interface Deployments {
  chainId: number
  aqua: string
  positionManager: string
  poolManager?: string
  router: string
  vault: string
  tokenA: string
  tokenB: string
  deployer: string
  permit2?: string
  pool?: { currency0: string; currency1: string; fee: number; tickSpacing: number; poolId: string }
  position?: { tokenId?: string; liquidity?: string; owner?: string }
  strategy?: StrategyRecord
  fills?: unknown[]
  [k: string]: unknown
}

export const readDeployments = (): Deployments => JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'))

export const writeDeployments = (next: Deployments): void =>
  writeFileSync(DEPLOYMENTS_PATH, `${JSON.stringify(next, null, 2)}\n`)

export interface StrategyParams {
  vault: Address
  positionManager: Address
  tokenA: Address
  tokenB: Address
  tokenId: bigint
  salt: Hex
  haircutBps: number
  maxUnwindPct: number
  unitsPerLiquidityE18: bigint
  /** Curve bounds of instruction `0x51`, taken from the record rather than recomputed from the ticks. */
  sqrtPriceMin: bigint
  sqrtPriceMax: bigint
}

/** The one place an order is composed, out of the four builders `aqua.ts` exports and nothing else. */
export function composeOrder(params: StrategyParams): Order {
  return buildOrder({
    maker: params.vault,
    tokenA: params.tokenA,
    tokenB: params.tokenB,
    program: buildProgram({
      salt: params.salt,
      concentrateArgs: buildConcentrateArgs({
        sqrtPriceMin: params.sqrtPriceMin,
        sqrtPriceMax: params.sqrtPriceMax,
      }),
      unwindArgs: buildUnwindArgs({
        positionManager: params.positionManager,
        tokenId: params.tokenId,
        haircutBps: params.haircutBps,
        maxUnwindPct: params.maxUnwindPct,
        unitsPerLiquidityE18: params.unitsPerLiquidityE18,
      }),
    }),
  })
}

export interface LoadedStrategy {
  order: Order
  /** `keccak256(abi.encode(order))`, which is both the Aqua strategy hash and the router's order hash. */
  orderHash: Hex
  /** `abi.encode(order)`, the exact blob Aqua hashed when the vault shipped it. */
  strategy: Hex
  params: StrategyParams
  record: StrategyRecord
  /** Sorted, in the order the pool and the order data use them. */
  token0: Address
  token1: Address
}

/**
 * Rebuild the live strategy and prove it against the recorded hash.
 *
 * Throws rather than returning a degraded value, because every caller of this is about to spend gas.
 */
export function loadStrategy(deployments: Deployments): LoadedStrategy {
  const record = deployments.strategy
  if (!record) throw new Error('no strategy in deployments/sepolia.json, run yarn aqua first')

  const tokenId = BigInt(deployments.position?.tokenId ?? 0)
  if (tokenId === 0n) throw new Error('no position in deployments/sepolia.json, run yarn setup first')

  // A record written before the move to instruction 0x51 has no curve bounds, and rebuilding it would produce
  // a program that hashes to something Aqua has never seen. Say which command fixes it rather than failing on
  // `BigInt(undefined)` three lines down.
  if (!record.sqrtPriceMin || !record.sqrtPriceMax) {
    throw new Error(
      'the recorded strategy predates the concentrated curve and carries no sqrt price bounds. Run yarn aqua ' +
        'to ship a program built on instruction 0x51.',
    )
  }

  const params: StrategyParams = {
    vault: getAddress(deployments.vault),
    positionManager: getAddress(deployments.positionManager),
    tokenA: getAddress(deployments.tokenA),
    tokenB: getAddress(deployments.tokenB),
    tokenId,
    salt: record.salt,
    haircutBps: record.haircutBps,
    maxUnwindPct: record.maxUnwindPct,
    unitsPerLiquidityE18: BigInt(record.unitsPerLiquidityE18),
    sqrtPriceMin: BigInt(record.sqrtPriceMin),
    sqrtPriceMax: BigInt(record.sqrtPriceMax),
  }

  const order = composeOrder(params)
  const strategy = encodeOrder(order)
  const orderHash = keccak256(strategy)

  if (orderHash !== record.orderHash) {
    throw new Error(
      `the order rebuilt from deployments/sepolia.json hashes to ${orderHash}, but yarn aqua shipped ` +
        `${record.orderHash}. The recorded parameters and the shipped strategy have diverged, so run ` +
        'yarn demo:reset to ship a strategy that matches.',
    )
  }
  if (order.data.toLowerCase() !== record.order.data.toLowerCase()) {
    throw new Error('order data diverged from the recorded blob despite a matching hash, which cannot happen')
  }

  const [token0, token1] =
    params.tokenA.toLowerCase() < params.tokenB.toLowerCase()
      ? [params.tokenA, params.tokenB]
      : [params.tokenB, params.tokenA]

  return { order, orderHash, strategy, params, record, token0, token1 }
}
