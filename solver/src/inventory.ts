/**
 * What every fill did to the maker's inventory. Run with `yarn inventory`.
 *
 * A fill is not balance neutral for the maker and never was. Decreasing a v4 position returns both tokens pro
 * rata, the fill pays the taker in one of them and is paid in the other, and the redeposit is two sided and
 * therefore capped by whichever token the maker keeps selling. So each fill leaves the vault holding more of
 * one token, less of the other, and a position smaller than it started, and the redeposit puts back a few
 * percent of what the unwind removed rather than all of it. That is a property of one directional flow rather
 * than a defect of this design, and `yarn rebalance` is the operation that reverses it.
 *
 * This command exists so that the number is on screen instead of in the vault. It reads three things out of
 * each fill's own receipt and computes nothing it cannot show the source of:
 *
 *   the vault's ERC20 `Transfer` logs, netted per token, which is the inventory drift of that fill;
 *   the PoolManager's two `ModifyLiquidity` events, which are the liquidity removed and the liquidity put back;
 *   the router's `Swapped`, which is what the taker actually traded.
 *
 * The closing panel compares the drift the fills accumulated against the float the vault holds now. The gap
 * between those two is exactly what a rebalance took out of the book and put back to work.
 *
 * `driftOf` below is the one piece of that worth lifting out: it takes a receipt and returns the same numbers
 * this table is built from, for a single fill. Nothing imports it yet, and it is internal to this command
 * until something does.
 */
import {
  createPublicClient,
  fallback,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { sepolia } from 'viem/chains'

import { SEPOLIA, env } from './config.js'
import { loadStrategy, readDeployments } from './strategy.js'

/** Under the smallest cap the fallback Sepolia endpoints enforce, the same figure the dashboard scan uses. */
const CHUNK = 9_000n
/** About six days of Sepolia at twelve seconds a block, which is longer than this project has existed. */
const DEFAULT_WINDOW = 45_000n

/**
 * Reading history needs a different endpoint from reading state, and it is worth naming why.
 *
 * The default endpoint everything else in this solver uses, `ethereum-sepolia-rpc.publicnode.com`, answers
 * every `eth_call` here instantly and answers `eth_getLogs` over any past range with
 * `Archive requests require a personal token`, HTTP 403 wrapped in a `-32602`, which reads as a malformed
 * request rather than as a paywall. drpc serves the same range for free at up to ten thousand blocks. So the
 * scan runs on a fallback list rather than on one endpoint, with whatever `SEPOLIA_RPC_URL` names first.
 */
const ARCHIVE_ENDPOINTS = ['https://sepolia.drpc.org', 'https://ethereum-sepolia-rpc.publicnode.com']

const erc20Abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
])

const vaultAbi = parseAbi([
  'event Unwound(bytes32 indexed orderHash, address indexed token, uint256 released, uint256 required)',
  'function reachableFromPosition() view returns (uint256)',
])

const routerAbi = parseAbi([
  'event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
])

const poolManagerAbi = parseAbi([
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
])

const posmAbi = parseAbi(['function getPositionLiquidity(uint256 tokenId) view returns (uint128)'])

const info = (label: string, value: unknown = '') => console.log(`    ${label}${value === '' ? '' : `  ${value}`}`)

export interface Drift {
  /** Net change in the vault's balance of each token, from the `Transfer` logs of that transaction. */
  token0: bigint
  token1: bigint
  /** Liquidity the unwind took out of the position, as a positive number. */
  removed: bigint
  /** Liquidity the redeposit put back. */
  putBack: bigint
  amountIn: bigint
  amountOut: bigint
}

/**
 * The inventory drift of one fill, read from its receipt.
 *
 * Netting the `Transfer` logs is the honest way to get this: it counts the unwind, the payment to the taker,
 * the taker's input and the redeposit in one pass, without assuming which of them moved what. `ModifyLiquidity`
 * carries a signed delta, so the decrease and the increase are told apart by sign rather than by order.
 */
export function driftOf(params: {
  receipt: TransactionReceipt
  vault: Address
  router: Address
  poolManager: Address
  poolId: Hex
  token0: Address
  token1: Address
}): Drift {
  const vault = params.vault.toLowerCase()
  const drift: Drift = { token0: 0n, token1: 0n, removed: 0n, putBack: 0n, amountIn: 0n, amountOut: 0n }

  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: params.receipt.logs.filter(
      (log) => getAddress(log.address) === params.token0 || getAddress(log.address) === params.token1,
    ),
  })
  for (const log of transfers) {
    const isToken0 = getAddress(log.address) === params.token0
    const value = log.args.value
    if (log.args.to.toLowerCase() === vault) {
      if (isToken0) drift.token0 += value
      else drift.token1 += value
    }
    if (log.args.from.toLowerCase() === vault) {
      if (isToken0) drift.token0 -= value
      else drift.token1 -= value
    }
  }

  const modifications = parseEventLogs({
    abi: poolManagerAbi,
    eventName: 'ModifyLiquidity',
    logs: params.receipt.logs.filter((log) => getAddress(log.address) === params.poolManager),
  }).filter((log) => log.args.id.toLowerCase() === params.poolId.toLowerCase())
  for (const log of modifications) {
    if (log.args.liquidityDelta < 0n) drift.removed += -log.args.liquidityDelta
    else drift.putBack += log.args.liquidityDelta
  }

  const swapped = parseEventLogs({
    abi: routerAbi,
    eventName: 'Swapped',
    logs: params.receipt.logs.filter((log) => getAddress(log.address) === params.router),
  }).at(0)
  if (swapped) {
    drift.amountIn = swapped.args.amountIn
    drift.amountOut = swapped.args.amountOut
  }

  return drift
}

/** `+1,000.00` and `-915.37`, padded so a column of them lines up. */
function signed(amount: bigint, width: number): string {
  const whole = formatUnits(amount, 18)
  const [integer = '0', fraction = ''] = whole.replace('-', '').split('.')
  const rounded = `${amount < 0n ? '-' : '+'}${integer}.${fraction.padEnd(2, '0').slice(0, 2)}`
  return rounded.padStart(width)
}

function parseWindow(): bigint {
  const raw = process.argv.find((arg) => arg.startsWith('--window='))?.slice(9)
  if (!raw) return DEFAULT_WINDOW
  if (!/^\d+$/.test(raw)) throw new Error(`--window must be a number of blocks, got ${raw}`)
  return BigInt(raw)
}

async function main() {
  const deployments = readDeployments()
  const strategy = loadStrategy(deployments)
  const endpoints = [env.rpcUrl, ...ARCHIVE_ENDPOINTS.filter((url) => url !== env.rpcUrl)]
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: fallback(
      endpoints.map((url) => http(url, { timeout: 20_000 })),
      { retryCount: 1 },
    ),
  })

  const vault = strategy.params.vault
  const router = getAddress(deployments.router)
  const poolManager = getAddress(SEPOLIA.poolManager)
  const positionManager = strategy.params.positionManager
  const tokenId = strategy.params.tokenId
  const { token0, token1 } = strategy
  const poolId = deployments.pool?.poolId as Hex
  if (!poolId) throw new Error('no pool in deployments/sepolia.json, run yarn setup first')

  const [symbol0, symbol1] = await Promise.all([
    publicClient.readContract({ address: token0, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({ address: token1, abi: erc20Abi, functionName: 'symbol' }),
  ])

  const head = await publicClient.getBlockNumber()
  const window = parseWindow()
  const floor = head > window ? head - window : 0n

  console.log('\nBebecita inventory, Ethereum Sepolia')
  info('book (vault)    ', vault)
  info('scanning        ', `blocks ${floor} to ${head}, in chunks of ${CHUNK}`)

  // Newest chunk first, so a rate limited endpoint still shows the fills that just happened. A fill is found by
  // the vault's own `Unwound`, which is emitted once per fill and by nothing else.
  const fills: { blockNumber: bigint; txHash: Hex }[] = []
  let scannedFrom = head + 1n
  let failure: string | null = null
  while (scannedFrom > floor) {
    const toBlock = scannedFrom - 1n
    const fromBlock = toBlock > floor + CHUNK ? toBlock - CHUNK : floor
    try {
      const logs = await publicClient.getLogs({
        address: vault,
        event: vaultAbi[0],
        fromBlock,
        toBlock,
      })
      for (const log of logs) {
        fills.push({ blockNumber: log.blockNumber ?? 0n, txHash: log.transactionHash as Hex })
      }
    } catch (cause) {
      // A capped or non archival endpoint fails here. Whatever was read stays, and the panel says how far the
      // scan got rather than claiming the book has no history.
      failure = cause instanceof Error ? cause.message.split('\n')[0]! : String(cause)
      break
    }
    scannedFrom = fromBlock
  }
  fills.sort((left, right) => (left.blockNumber < right.blockNumber ? -1 : 1))

  if (failure) info('scan stopped    ', `${failure}, at block ${scannedFrom}`)
  info('fills found     ', fills.length)

  if (fills.length === 0) {
    console.log('\nNo fills in the window. Widen it with --window=100000, or run yarn fill.\n')
    return
  }

  console.log(
    `\n    ${'block'.padEnd(10)}${'fill'.padEnd(14)}${`drift ${symbol0}`.padStart(16)}${`drift ${symbol1}`.padStart(16)}` +
      `${'removed'.padStart(14)}${'put back'.padStart(14)}${'restored'.padStart(10)}`,
  )

  let total: Drift = { token0: 0n, token1: 0n, removed: 0n, putBack: 0n, amountIn: 0n, amountOut: 0n }
  for (const fill of fills) {
    const receipt = await publicClient.getTransactionReceipt({ hash: fill.txHash })
    const drift = driftOf({ receipt, vault, router, poolManager, poolId, token0, token1 })
    const restored = drift.removed === 0n ? 0n : (drift.putBack * 10_000n) / drift.removed

    console.log(
      `    ${fill.blockNumber.toString().padEnd(10)}${`${fill.txHash.slice(0, 10)}...`.padEnd(14)}` +
        `${signed(drift.token0, 16)}${signed(drift.token1, 16)}` +
        `${signed(-drift.removed, 14)}${signed(drift.putBack, 14)}${`${formatUnits(restored, 2)}%`.padStart(10)}`,
    )

    total = {
      token0: total.token0 + drift.token0,
      token1: total.token1 + drift.token1,
      removed: total.removed + drift.removed,
      putBack: total.putBack + drift.putBack,
      amountIn: total.amountIn + drift.amountIn,
      amountOut: total.amountOut + drift.amountOut,
    }
  }

  const restoredOverall = total.removed === 0n ? 0n : (total.putBack * 10_000n) / total.removed
  console.log(
    `    ${''.padEnd(10)}${`${fills.length} fills`.padEnd(14)}${signed(total.token0, 16)}${signed(total.token1, 16)}` +
      `${signed(-total.removed, 14)}${signed(total.putBack, 14)}${`${formatUnits(restoredOverall, 2)}%`.padStart(10)}`,
  )

  const [float0, float1, liquidity, reachable] = await Promise.all([
    publicClient.readContract({ address: token0, abi: erc20Abi, functionName: 'balanceOf', args: [vault] }),
    publicClient.readContract({ address: token1, abi: erc20Abi, functionName: 'balanceOf', args: [vault] }),
    publicClient.readContract({ address: positionManager, abi: posmAbi, functionName: 'getPositionLiquidity', args: [tokenId] }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'reachableFromPosition' }),
  ])

  console.log('\n    What that adds up to')
  info('  drift         ', `${formatUnits(total.token0, 18)} ${symbol0} and ${formatUnits(total.token1, 18)} ${symbol1}, over ${fills.length} fills`)
  info('  redeposited   ', `${formatUnits(restoredOverall, 2)}% of the liquidity the unwinds removed, the rest is the two sided cap`)
  info('  float now     ', `${formatUnits(float0, 18)} ${symbol0} / ${formatUnits(float1, 18)} ${symbol1}`)
  info('  position now  ', `${formatUnits(liquidity, 18)} of liquidity, ${formatUnits(reachable, 18)} ${symbol1} reachable`)

  // The drift is what the fills did. The float is what is left of it. A gap between them is a rebalance, and
  // no gap at all means the inventory has never been traded home.
  const traded0 = total.token0 - float0
  const traded1 = total.token1 - float1
  if (traded0 > 0n || traded1 > 0n) {
    info('  traded home   ', `${formatUnits(traded0, 18)} ${symbol0} and ${formatUnits(traded1, 18)} ${symbol1} are drift that yarn rebalance already put back to work`)
  } else {
    info('  traded home   ', 'nothing yet, the whole drift is still sitting in the vault. Run yarn rebalance.')
  }
  console.log()
}

main().catch((error) => {
  console.error(`\n${error}`)
  process.exit(1)
})
