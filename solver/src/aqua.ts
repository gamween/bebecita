/**
 * The Aqua strategy the order book quotes.
 *
 * Run with `yarn aqua`, after `yarn setup`. It builds the SwapVM order, ships it from the vault, and checks
 * the hash Aqua stored against the hash the router derives.
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

import { env } from './config.js'

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
const OP_XYC_SWAP = 0x50
const OP_UNWIND_PRICED_BALANCE_OUT = 0x92

/** Risk parameters. These must match the vault, because the guards and the instruction read the same numbers. */
const HAIRCUT_BPS = 500
const MAX_UNWIND_PCT = 25
const UNITS_PER_LIQUIDITY_E18 = 10n ** 18n

/**
 * Virtual balances shipped, asymmetric on purpose.
 *
 * `XYCSwap` is constant product over `(balanceIn, balanceOut)`, and instruction `0x92` lowers `balanceOut`
 * only. So the book quotes roughly `balanceOut / balanceIn`, and the two sides do different jobs.
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
 * The program: clamp the output balance to what the position can release, then price on the constant product
 * curve, then a salt.
 *
 * The salt is not decoration. A strategy hash can be shipped exactly once, ever: `Aqua.ship` requires
 * `tokensCount == 0` and `Aqua.dock` sets it to `0xff` permanently, so replaying a demo needs a program that
 * hashes differently. `0x02` exists for that and its argument is ignored by the VM.
 */
export function buildProgram(params: { unwindArgs: Hex; salt: Hex }): Hex {
  const args = params.unwindArgs
  const argsLength = (args.length - 2) / 2

  return concatHex([
    byte(OP_UNWIND_PRICED_BALANCE_OUT),
    byte(argsLength),
    args,
    byte(OP_XYC_SWAP),
    byte(0),
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

  const order = buildOrder({
    maker: vault,
    tokenA,
    tokenB,
    program: buildProgram({
      salt,
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
  info('program         ', `${(order.data.length - 2) / 2 - 40} bytes`)
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
  info('reachable       ', reachable)
  info('shipping token0 ', amount0)
  info('shipping token1 ', amount1)

  const hash = await wallet.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'ship',
    args: [router, strategy, [token0, token1], [amount0, amount1]],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
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

  deployments.strategy = {
    orderHash: routerHash,
    salt,
    shipped: { token0: amount0.toString(), token1: amount1.toString() },
    reachableAtShip: reachable.toString(),
    haircutBps: HAIRCUT_BPS,
    maxUnwindPct: MAX_UNWIND_PCT,
    unitsPerLiquidityE18: UNITS_PER_LIQUIDITY_E18.toString(),
    order: { maker: order.maker, traits: order.traits.toString(), data: order.data },
    shipTx: hash,
  }
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(deployments, null, 2)}\n`)

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
