/**
 * The Aqua strategy the order book quotes.
 *
 * Run with `yarn aqua`, after `yarn setup`. It reads the pool through `POST /lp/pool_info`, compiles the
 * position's range into the program as the curve's price bounds, builds the SwapVM order, ships it from the
 * vault, and checks the hash Aqua stored against the hash the router derives.
 *
 * The one rule that decides whether any of this works: the strategy blob shipped to Aqua must be
 * `abi.encode(order)` byte for byte. `Aqua.ship` hashes whatever bytes it is given, `SwapVM.hash` returns
 * `keccak256(abi.encode(order))` for an order with `useAquaInsteadOfSignature`, and `safeBalances` is looked up
 * under that hash. One byte of difference and every fill reverts inside Aqua with nothing in the revert data
 * pointing at the encoding, so the final assertion here is not a formality.
 *
 * The order itself is `MakerTraitsLib.build` transcribed. That library is `internal pure`, so a script cannot
 * call it, and the bit layout is reproduced below with the flags named after their Solidity constants.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  numberToHex,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import { SEPOLIA, env } from './config.js'
import { UniswapClient } from './uniswap.js'

const ROOT = resolve(import.meta.dirname, '../..')
const DEPLOYMENTS = resolve(ROOT, 'deployments/sepolia.json')

// MakerTraits bit layout, from swap-vm/src/libs/MakerTraits.sol. Bits 255 to 245 are flags, bits 224 to 160
// hold the four slice indexes, and the low 160 bits hold the receiver.
const USE_AQUA_INSTEAD_OF_SIGNATURE_BIT_FLAG = 1n << 254n
const HAS_POST_TRANSFER_IN_HOOK_BIT_FLAG = 1n << 251n
const HAS_PRE_TRANSFER_OUT_HOOK_BIT_FLAG = 1n << 250n
const ORDER_DATA_SLICES_INDEXES_BIT_OFFSET = 160n

// Opcodes, from swap-vm/src/libs/OpcodeList.sol.
const OP_SALT = 0x02
const OP_XYC_CONCENTRATE_SWAP = 0x51
const OP_UNWIND_PRICED_BALANCE_OUT = 0x92

/** Risk parameters. These must match the vault, because the guards and the instruction read the same numbers. */
const HAIRCUT_BPS = 500
const MAX_UNWIND_PCT = 25
const UNITS_PER_LIQUIDITY_E18 = 10n ** 18n

/**
 * Virtual balances shipped, asymmetric on purpose.
 *
 * `XYCConcentrate` prices on a concentrated curve whose virtual reserves are rebuilt from `(balanceIn,
 * balanceOut)` and the two price bounds below, and instruction `0x92` lowers `balanceOut` only. The position
 * funding this book is full range, so the bounds sit far outside the traded price and the virtual reserves add
 * about a billionth of the real ones: the curve is constant product to nine significant digits, the book still
 * quotes roughly `balanceOut / balanceIn`, and the two sides do different jobs.
 *
 * The OUTPUT side is shipped generously. Aqua performs no solvency check, so that number is a quote-side
 * ceiling and nothing else, and it is exactly what makes the instruction's absence bite: run the same program
 * without `0x92` and it overstates its depth by a large factor on every fill, not only on large ones, so the
 * hook's shortfall guard catches an ordinary sized order rather than an exotic one.
 *
 * The INPUT side is shipped just above what the position can actually release. That is what brings the price
 * back to something a human can read: with the instruction clamping the output to `reachable`, the quote lands
 * near parity instead of at the 0.0237 that a symmetric generous shipping produced.
 *
 * Both figures are derived from `vault.reachableFromPosition()` rather than hardcoded, so the relationship
 * survives a change of position size, of `maxUnwindPct`, or of the haircut.
 *
 * The consequence to know: the reverse direction quotes poorly, because its input side is the generous one.
 * The demo fills one direction, and the reverse is not part of it.
 */
const INPUT_SHIPPED_NUMERATOR = 105n
const INPUT_SHIPPED_DENOMINATOR = 100n
const OUTPUT_SHIPPED_MULTIPLE = 40n

/**
 * The curve, and why it is `0x51` and not `0x50`.
 *
 * `XYCSwap`, opcode `0x50`, never clamps its own output. In exact-out it computes
 * `amountIn = ceilDiv(amountOut * balanceIn, balanceOut - amountOut)`, so a taker who asks for at least the
 * balance the book holds gets an arithmetic panic out of the VM: underflow above it, division by zero at it.
 * In exact-in it silently asymptotes instead.
 *
 * `XYCConcentrate`, opcode `0x51`, clamps on `balanceOut` in BOTH directions and re-solves the other side for
 * the clamped amount. Read `node_modules/@1inch/swap-vm/src/instructions/XYCConcentrate.sol`: in exact-in,
 * `if (out > ctx.swap.balanceOut) { out = ctx.swap.balanceOut; ctx.swap.amountIn = Math.ceilDiv(out *
 * virtualBalanceIn, virtualBalanceOut - out); }`, and in exact-out the same clamp followed by the same solve.
 * That reassignment of `ctx.swap.amountIn` is the partial fill work that landed in `swap-vm` main on
 * 2026-07-22, three days before this hackathon, and it is the whole reason for this change.
 *
 * The consequence for this project. Instruction `0x92` exists to lower `balanceOut` to what the Uniswap
 * position can genuinely release. Whenever it clamps below what the taker asked for, `0x50` either panics or
 * quotes into thin air and the vault's shortfall guard catches it at the end of the program. `0x51` turns the
 * same moment into an exact partial: the taker is paid exactly the reachable collateral and charged exactly
 * what that costs. `TakerTraitsLib.validate` was written for this, it requires `takerAmount >= amountIn` on
 * exact-in and `takerAmount >= amountOut` on exact-out, never equality, so a partial is a legal fill and not a
 * tolerated accident.
 *
 * And the arguments are the position. `0x51` takes `sqrtPriceMin` and `sqrtPriceMax`, so the book's curve is
 * the range of the Uniswap position backing it, read from `POST /lp/pool_info` and compiled into the program
 * bytes. The API's answer stops being a display value.
 */

/** Fixed point basis of both bounds, `ONE` in `XYCConcentrate.sol`. `sqrtPrice` is `sqrt(tokenGt/tokenLt)`. */
const SQRT_PRICE_ONE = 10n ** 18n

/**
 * Widest half window the instruction's fixed point can carry, as a factor on the sqrt price either side of spot.
 *
 * Full range does not survive the conversion, and this is the number that says so. The position is
 * `[-887220, 887220]`, and `sqrt(1.0001^-887220)` is `5.4e-20`: in 1e18 fixed point that is `0.054`, which
 * truncates to zero, and `XYCConcentrateArgsBuilder.build2D` rejects a zero lower bound with
 * `ConcentrateInvalidPriceBounds`. The upper bound survives at `1.8e37` but on its own it is meaningless, so
 * the range is clamped symmetrically in log space around the live spot price instead.
 *
 * A billion on the sqrt side is a factor of 1e18 on the price either way, which is ticks `-414486` to
 * `414486`, and it is chosen for three reasons. It leaves nine significant digits at the floor, where one tick
 * is a relative step of 5e-5, so neighbouring ticks stay four orders of magnitude apart from each other. It
 * keeps `beta * beta` in `XYCConcentrateArgsBuilder._computeL` far from overflowing, that being a raw
 * multiplication rather than a `mulDiv`. And a price window of 1e18 either side of spot is wider than any
 * range a v4 position on a pair of 18 decimal tokens can express, so the clamp only ever binds on full range,
 * which is exactly the case it exists for.
 *
 * Nothing here fabricates a range. A maker who re-ranges the position tighter than this window gets the real
 * ticks compiled into the program, and the book concentrates with it.
 */
const SQRT_PRICE_HALF_WINDOW = 10n ** 9n

/** Uniswap's Q96 basis, the format `/lp/pool_info` reports `sqrtRatioX96` in. */
const Q96 = 2n ** 96n

/**
 * `sqrt(1.0001^tick)` in 1e18 fixed point.
 *
 * Deliberately double precision. This number defines the shape of a curve, it never settles anything: the
 * amounts a fill pays are decided by the VM from these bounds, and the tokens that back them are checked
 * against the realised balance delta by the vault's first guard. Doubles carry fifteen significant digits
 * where the fixed point below needs nine, and IEEE754 is deterministic, so the same tick always compiles to
 * the same bytes. The value is recorded in `deployments/sepolia.json` and rebuilt from that record by
 * `strategy.ts`, so nothing downstream ever recomputes it.
 *
 * Both full range bounds land outside the window above and are clamped, so on this position the conversion is
 * only exercised as a comparison.
 */
export function sqrtPriceE18FromTick(tick: number): bigint {
  if (!Number.isInteger(tick)) throw new Error(`tick must be an integer, got ${tick}`)
  return BigInt(Math.round(Math.pow(1.0001, tick / 2) * 1e18))
}

export interface ConcentrateBounds {
  sqrtPriceMin: bigint
  sqrtPriceMax: bigint
  /** `sqrt(P)` of the live pool in the same fixed point, the anchor the window is centred on. */
  sqrtPriceSpot: bigint
  /** What the position's own ticks convert to, before clamping. Equal to the bounds when nothing was clamped. */
  fromTicks: { lower: bigint; upper: bigint }
  clampedLower: boolean
  clampedUpper: boolean
}

/**
 * The bounds the program is parameterised with: the position's ticks, clamped to what the fixed point carries.
 *
 * `sqrtPriceX96` comes from `POST /lp/pool_info` and is the only live input. It is converted to the
 * instruction's 1e18 basis and used as the centre of the clamp window, so the window follows the pool rather
 * than assuming parity.
 */
export function concentrateBounds(params: {
  sqrtPriceX96: bigint
  tickLower: number
  tickUpper: number
}): ConcentrateBounds {
  if (params.tickLower >= params.tickUpper) {
    throw new Error(`tickLower ${params.tickLower} must be below tickUpper ${params.tickUpper}`)
  }

  const sqrtPriceSpot = (params.sqrtPriceX96 * SQRT_PRICE_ONE) / Q96
  if (sqrtPriceSpot === 0n) throw new Error('pool_info reports a sqrt price below the instruction fixed point')

  const floor = sqrtPriceSpot / SQRT_PRICE_HALF_WINDOW
  const ceiling = sqrtPriceSpot * SQRT_PRICE_HALF_WINDOW
  const fromTicks = {
    lower: sqrtPriceE18FromTick(params.tickLower),
    upper: sqrtPriceE18FromTick(params.tickUpper),
  }

  return {
    sqrtPriceMin: fromTicks.lower > floor ? fromTicks.lower : floor,
    sqrtPriceMax: fromTicks.upper < ceiling ? fromTicks.upper : ceiling,
    sqrtPriceSpot,
    fromTicks,
    clampedLower: fromTicks.lower <= floor,
    clampedUpper: fromTicks.upper >= ceiling,
  }
}

/**
 * Arguments of instruction `0x51`, in the layout `XYCConcentrateArgsBuilder.build2D` encodes and parses.
 *
 * `abi.encodePacked(uint256 sqrtPriceMin, uint256 sqrtPriceMax)`, 64 bytes, big endian, 1e18 fixed point, and
 * `parse2D` reads them back at offsets 0 and 32. The builder's own precondition is reproduced verbatim
 * because it is the one that fires on full range.
 */
export function buildConcentrateArgs(params: { sqrtPriceMin: bigint; sqrtPriceMax: bigint }): Hex {
  if (params.sqrtPriceMin <= 0n || params.sqrtPriceMin >= params.sqrtPriceMax) {
    throw new Error(
      `ConcentrateInvalidPriceBounds(${params.sqrtPriceMin}, ${params.sqrtPriceMax}): build2D requires ` +
        '0 < sqrtPriceMin < sqrtPriceMax',
    )
  }
  return concatHex([
    numberToHex(params.sqrtPriceMin, { size: 32 }),
    numberToHex(params.sqrtPriceMax, { size: 32 }),
  ])
}

/**
 * The two raw multiplications inside the sponsor's curve, checked against the balances about to be shipped.
 *
 * `XYCConcentrateArgsBuilder._computeL` computes `beta = bLt * sqrtPriceMin / 1e18 + bGt * 1e18 / sqrtPriceMax`
 * and then `beta * beta`, and it forms `bLt * bGt`, both as plain multiplications with no 512 bit intermediate.
 * Neither can overflow at the sizes this book ships, and this is where that stops being an assumption.
 */
export function assertCurveArithmeticFits(params: {
  balanceLt: bigint
  balanceGt: bigint
  sqrtPriceMin: bigint
  sqrtPriceMax: bigint
}): void {
  const max = 2n ** 256n - 1n
  const beta =
    (params.balanceLt * params.sqrtPriceMin) / SQRT_PRICE_ONE +
    (params.balanceGt * SQRT_PRICE_ONE) / params.sqrtPriceMax
  if (beta * beta > max) throw new Error('sqrtPriceMin is too high for these balances, beta * beta overflows')
  if (params.balanceLt * params.balanceGt > max) throw new Error('shipped balances overflow bLt * bGt')
}

/** Splits the two shipped figures according to which token the demo direction pays out. */
function shippedAmounts(reachable: bigint, token0: Address, demoTokenOut: Address): [bigint, bigint] {
  const input = (reachable * INPUT_SHIPPED_NUMERATOR) / INPUT_SHIPPED_DENOMINATOR
  const output = reachable * OUTPUT_SHIPPED_MULTIPLE
  return token0.toLowerCase() === demoTokenOut.toLowerCase() ? [output, input] : [input, output]
}

export interface Order {
  maker: Address
  traits: bigint
  data: Hex
}

const orderAbi = [
  {
    type: 'tuple',
    components: [
      { name: 'maker', type: 'address' },
      { name: 'traits', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
  },
] as const

const routerAbi = parseAbi([
  'struct Order { address maker; uint256 traits; bytes data; }',
  'function hash(Order order) view returns (bytes32)',
])

const vaultAbi = parseAbi([
  'function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)',
  'function TOKEN_ID() view returns (uint256)',
])

/** `abi.encode(order)`, which is the only encoding Aqua and the router agree on. */
export function encodeOrder(order: Order): Hex {
  return encodeAbiParameters(orderAbi, [order])
}

/** `keccak256(abi.encode(order))`, the strategy hash, computed locally so it can be checked against the chain. */
export function orderHash(order: Order): Hex {
  return keccak256(encodeOrder(order))
}

/** One byte, unsigned, as two hex characters. Used for opcodes and for argument lengths. */
const byte = (value: number): Hex => numberToHex(value, { size: 1 })

/**
 * Arguments of instruction `0x92`, in the layout `UnwindPricedBalancesArgsBuilder` encodes and parses.
 *
 * positionManager 20 | tokenId 32 | haircutBps 2 | maxUnwindPct 1 | unitsPerLiquidityE18 16, for 71 bytes.
 * The builder rejects a haircut of 100%, an unwind share outside 1..100, and a zero conversion factor, so the
 * same three checks are made here rather than discovering them inside a revert.
 */
export function buildUnwindArgs(params: {
  positionManager: Address
  tokenId: bigint
  haircutBps: number
  maxUnwindPct: number
  unitsPerLiquidityE18: bigint
}): Hex {
  if (params.haircutBps >= 10_000) throw new Error('haircutBps must leave something to quote against')
  if (params.maxUnwindPct < 1 || params.maxUnwindPct > 100) {
    throw new Error('maxUnwindPct is an integer in 1..100, the granularity of liquidityPercentageToDecrease')
  }
  if (params.unitsPerLiquidityE18 <= 0n) throw new Error('unitsPerLiquidityE18 must be positive')

  return concatHex([
    getAddress(params.positionManager),
    numberToHex(params.tokenId, { size: 32 }),
    numberToHex(params.haircutBps, { size: 2 }),
    numberToHex(params.maxUnwindPct, { size: 1 }),
    numberToHex(params.unitsPerLiquidityE18, { size: 16 }),
  ])
}

/**
 * The program: clamp the output balance to what the position can release, then price on the position's own
 * range, then a salt.
 *
 * `[0x92 unwind][0x51 concentrate][0x02 salt]`. The order of the first two is forced from both ends. `0x92`
 * requires both amount registers to still be zero, so it cannot follow a curve, and `0x51` is terminal and
 * reads `balanceOut` after the clamp, which is the entire point: the curve prices against reachable
 * collateral, and clamps its own output at the same number when a taker asks for more.
 *
 * The salt is not decoration. A strategy hash can be shipped exactly once, ever: `Aqua.ship` requires
 * `tokensCount == 0` and `Aqua.dock` sets it to `0xff` permanently, so replaying a demo needs a program that
 * hashes differently. `0x02` exists for that and its argument is ignored by the VM.
 */
export function buildProgram(params: { unwindArgs: Hex; concentrateArgs: Hex; salt: Hex }): Hex {
  const unwind = params.unwindArgs
  const concentrate = params.concentrateArgs
  const length = (hex: Hex) => (hex.length - 2) / 2

  // `VM.sol:131` reads the argument length from one byte of the program word, so 64 is legal and 256 is not.
  if (length(concentrate) !== 64) throw new Error(`0x51 takes 64 bytes of arguments, got ${length(concentrate)}`)

  return concatHex([
    byte(OP_UNWIND_PRICED_BALANCE_OUT),
    byte(length(unwind)),
    unwind,
    byte(OP_XYC_CONCENTRATE_SWAP),
    byte(length(concentrate)),
    concentrate,
    byte(OP_SALT),
    byte(1),
    params.salt,
  ])
}

/**
 * `MakerTraitsLib.build`, transcribed for the case this project uses.
 *
 * No hook has a target or maker data, so all four slice indexes are 40, the length of the two token addresses
 * that open `data`. The hooks still fire: `hasPreTransferOutHook` and `hasPostTransferInHook` are what make
 * the router call the vault, and the calldata they execute arrives per fill through the taker traits, because
 * the Uniswap API builds it against live chain state and it cannot be baked into an immutable order.
 */
export function buildOrder(params: {
  maker: Address
  tokenA: Address
  tokenB: Address
  program: Hex
}): Order {
  const [token0, token1] =
    params.tokenA.toLowerCase() < params.tokenB.toLowerCase()
      ? [getAddress(params.tokenA), getAddress(params.tokenB)]
      : [getAddress(params.tokenB), getAddress(params.tokenA)]

  const index = 40n
  const orderDataIndexes = index | (index << 16n) | (index << 32n) | (index << 48n)

  // Receiver stays zero, which SwapVM reads as "pay the maker". SHOULD_UNWRAP, ALLOW_ZERO_AMOUNT_IN,
  // HAS_PRE_TRANSFER_IN_HOOK and HAS_POST_TRANSFER_OUT_HOOK stay unset, and none of the four HAS_TARGET bits
  // is set because both hooks live on the maker itself.
  const traits =
    USE_AQUA_INSTEAD_OF_SIGNATURE_BIT_FLAG |
    HAS_POST_TRANSFER_IN_HOOK_BIT_FLAG |
    HAS_PRE_TRANSFER_OUT_HOOK_BIT_FLAG |
    (orderDataIndexes << ORDER_DATA_SLICES_INDEXES_BIT_OFFSET)

  return { maker: getAddress(params.maker), traits, data: concatHex([token0, token1, params.program]) }
}

interface Deployments {
  router: string
  vault: string
  tokenA: string
  tokenB: string
  positionManager: string
  pool?: {
    currency0: string
    currency1: string
    fee: number
    tickSpacing: number
    hooks?: string
    tickLower: number
    tickUpper: number
  }
  position?: { tokenId?: string }
  strategy?: Record<string, unknown>
  [k: string]: unknown
}

const info = (label: string, value: unknown = '') => console.log(`    ${label}${value === '' ? '' : `  ${value}`}`)

async function main() {
  const deployments: Deployments = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
  const account = privateKeyToAccount(env.privateKey as Hex)
  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.rpcUrl) })
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(env.rpcUrl) })

  const router = getAddress(deployments.router)
  const vault = getAddress(deployments.vault)
  const positionManager = getAddress(deployments.positionManager)
  const tokenA = getAddress(deployments.tokenA)
  const tokenB = getAddress(deployments.tokenB)
  const tokenId = BigInt(deployments.position?.tokenId ?? 0)

  if (tokenId === 0n) throw new Error('no position in deployments/sepolia.json, run yarn setup first')

  // The vault's own tokenId is immutable, so an order that priced against a different one would quote depth
  // belonging to somebody else's position.
  const vaultTokenId = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'TOKEN_ID' })
  if (vaultTokenId !== tokenId) {
    throw new Error(`vault ${vault} points at tokenId ${vaultTokenId}, deployments say ${tokenId}`)
  }

  const salt = (process.argv.find((arg) => arg.startsWith('--salt='))?.slice(7) ??
    toHex(Math.floor(Math.random() * 256), { size: 1 })) as Hex

  // ---------------------------------------------------------------------
  // The curve, read from the pool that funds it
  // ---------------------------------------------------------------------

  const pool = deployments.pool
  if (!pool) throw new Error('no pool in deployments/sepolia.json, run yarn setup first')

  const uniswap = new UniswapClient({ apiKey: env.apiKey, chainId: SEPOLIA.chainId, protocol: 'V4' })
  const poolInfo = await uniswap.poolInfo({
    tokenA: pool.currency0,
    tokenB: pool.currency1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
    hooks: pool.hooks,
  })
  const live = (poolInfo.pools ?? []).at(0)
  if (!live?.sqrtRatioX96) throw new Error('pool_info returned no state for the pool that funds this book')

  const bounds = concentrateBounds({
    sqrtPriceX96: BigInt(live.sqrtRatioX96),
    tickLower: pool.tickLower,
    tickUpper: pool.tickUpper,
  })
  const concentrateArgs = buildConcentrateArgs(bounds)

  const order = buildOrder({
    maker: vault,
    tokenA,
    tokenB,
    program: buildProgram({
      salt,
      concentrateArgs,
      unwindArgs: buildUnwindArgs({
        positionManager,
        tokenId,
        haircutBps: HAIRCUT_BPS,
        maxUnwindPct: MAX_UNWIND_PCT,
        unitsPerLiquidityE18: UNITS_PER_LIQUIDITY_E18,
      }),
    }),
  })

  const strategy = encodeOrder(order)
  const localHash = keccak256(strategy)

  console.log('\nBebecita strategy, Ethereum Sepolia')
  info('maker (vault)   ', order.maker)
  info('app (router)    ', router)
  info('tokenId         ', tokenId)
  info('salt            ', salt)
  info('program         ', `${(order.data.length - 2) / 2 - 40} bytes, 0x92 unwind, 0x51 concentrate, 0x02 salt`)
  info('traits          ', `0x${order.traits.toString(16)}`)
  info('strategy blob   ', `${(strategy.length - 2) / 2} bytes, abi.encode(order)`)

  // The router derives the same hash from the same order. Checking it before shipping means a mismatch costs
  // nothing, where discovering it later costs a reverted fill with no useful revert data.
  const routerHash = await publicClient.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'hash',
    args: [order],
  })
  if (routerHash !== localHash) {
    throw new Error(`router.hash is ${routerHash}, keccak256(abi.encode(order)) is ${localHash}`)
  }
  info('orderHash       ', routerHash)

  // The curve the book quotes on, as the position defines it. `price` here is `tokenGt/tokenLt`, which is the
  // same orientation as Uniswap's `token1/token0`, so these numbers can be read against the pool directly.
  const price = (sqrtPrice: bigint) => (Number(sqrtPrice) / 1e18) ** 2
  console.log()
  info('pool tick       ', `${live.currentTick}, sqrtRatioX96 ${live.sqrtRatioX96}`)
  info('position range  ', `ticks ${pool.tickLower} to ${pool.tickUpper}`)
  info('sqrtPriceSpot   ', `${bounds.sqrtPriceSpot}, price ${price(bounds.sqrtPriceSpot).toExponential(3)}`)
  info(
    'sqrtPriceMin    ',
    `${bounds.sqrtPriceMin}, price ${price(bounds.sqrtPriceMin).toExponential(3)}` +
      (bounds.clampedLower ? `  clamped, the tick converts to ${bounds.fromTicks.lower}` : ''),
  )
  info(
    'sqrtPriceMax    ',
    `${bounds.sqrtPriceMax}, price ${price(bounds.sqrtPriceMax).toExponential(3)}` +
      (bounds.clampedUpper ? `  clamped, the tick converts to ${bounds.fromTicks.upper}` : ''),
  )

  const [token0, token1] =
    tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA]

  // The clamp target, read from the chain rather than assumed, so the shipped figures track the position.
  const reachable = await publicClient.readContract({
    address: vault,
    abi: parseAbi(['function reachableFromPosition() view returns (uint256)']),
    functionName: 'reachableFromPosition',
  })
  if (reachable === 0n) {
    throw new Error('reachableFromPosition is 0, the vault owns no position liquidity yet, run yarn setup')
  }
  // Direction. The taker's `isAToB` bit makes tokenIn the lower sorted address, so the output side of the
  // demo direction is token1. Verified against a live quote: shipping the generous side as the input instead
  // reproduces the 0.025 price this change exists to fix.
  const [amount0, amount1] = shippedAmounts(reachable, token0, token1)
  console.log()
  info('reachable       ', reachable)
  info('shipping token0 ', amount0)
  info('shipping token1 ', amount1)

  // token0 is the lower address, which is `bLt` in the curve's own naming.
  assertCurveArithmeticFits({
    balanceLt: amount0,
    balanceGt: amount1,
    sqrtPriceMin: bounds.sqrtPriceMin,
    sqrtPriceMax: bounds.sqrtPriceMax,
  })

  /** Everything `yarn fill` and `yarn demo:reset` need to rebuild this exact order, byte for byte. */
  const writeStrategyRecord = (shipTx: Hex): void => {
    deployments.strategy = {
      orderHash: routerHash,
      salt,
      shipped: { token0: amount0.toString(), token1: amount1.toString() },
      reachableAtShip: reachable.toString(),
      haircutBps: HAIRCUT_BPS,
      maxUnwindPct: MAX_UNWIND_PCT,
      unitsPerLiquidityE18: UNITS_PER_LIQUIDITY_E18.toString(),
      // The two curve bounds are part of the program bytes, so `strategy.ts` rebuilds the order from these
      // and never recomputes them: a tick converted twice must not be allowed to differ by one wei.
      sqrtPriceMin: bounds.sqrtPriceMin.toString(),
      sqrtPriceMax: bounds.sqrtPriceMax.toString(),
      curve: {
        instruction: '0x51 XYCConcentrateSwap',
        tickLower: pool.tickLower,
        tickUpper: pool.tickUpper,
        sqrtPriceSpotAtShip: bounds.sqrtPriceSpot.toString(),
        sqrtRatioX96AtShip: String(live.sqrtRatioX96),
        currentTickAtShip: live.currentTick,
        sqrtPriceMinFromTick: bounds.fromTicks.lower.toString(),
        sqrtPriceMaxFromTick: bounds.fromTicks.upper.toString(),
        clampedLower: bounds.clampedLower,
        clampedUpper: bounds.clampedUpper,
      },
      order: { maker: order.maker, traits: order.traits.toString(), data: order.data },
      shipTx,
    }
    writeFileSync(DEPLOYMENTS, `${JSON.stringify(deployments, null, 2)}\n`)
  }

  const hash = await wallet.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'ship',
    args: [router, strategy, [token0, token1], [amount0, amount1]],
  })

  writeStrategyRecord(hash)
  info('sent            ', hash)

  // The public Sepolia endpoints are slow enough to blow through viem's default wait, and losing the record to
  // a timeout is the worst outcome available: the strategy is live, a salt is spent, and nothing on disk says
  // so. Hence the record above, written the moment the transaction is sent rather than once it confirms.
  const receipt = await publicClient
    .waitForTransactionReceipt({ hash, timeout: 600_000, pollingInterval: 2_000 })
    .catch(() => {
      throw new Error(
        `ship ${hash} has not confirmed yet. deployments/sepolia.json already describes it, so check the ` +
          'transaction and run yarn fill once it lands. Do not rerun this command, it would spend a salt.',
      )
    })
  if (receipt.status !== 'success') {
    throw new Error(`ship reverted, ${hash}. A repeated strategy hash reverts with StrategiesMustBeImmutable`)
  }
  info('shipped         ', `${hash}  gas ${receipt.gasUsed}`)

  // Aqua stores the balance under keccak256(strategy). Reading it back proves the blob, the hash and the
  // lookup the router will perform all agree.
  const aqua = getAddress(deployments.aqua as string)
  const [balance0, balance1] = await publicClient.readContract({
    address: aqua,
    abi: parseAbi([
      'function safeBalances(address maker, address app, bytes32 strategyHash, address token0, address token1) view returns (uint256, uint256)',
    ]),
    functionName: 'safeBalances',
    args: [vault, router, routerHash, token0, token1],
  })
  info('aqua balance0   ', balance0)
  info('aqua balance1   ', balance1)
  if (balance0 !== amount0 || balance1 !== amount1) {
    throw new Error('Aqua stored a different balance than the one shipped')
  }

  console.log('\nStrategy open. The book quotes against it now.')
  info('written to      ', 'deployments/sepolia.json')
  console.log()
}

// Only run when invoked directly, so the builders above can be imported by the fill orchestration.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`\n${error}`)
    process.exit(1)
  })
}
