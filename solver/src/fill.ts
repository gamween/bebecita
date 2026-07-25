/**
 * One complete fill on Ethereum Sepolia, funded by unwinding the Uniswap position inside the same transaction.
 *
 * Run with `yarn fill`, after `yarn setup` and `yarn aqua`. This is the whole product in one command: it
 * quotes the book, sizes the withdrawal from that quote, asks the Uniswap API for the two payloads, hands them
 * to a Foundry script that encodes the taker traits, and sends the swap from the taker's own key.
 *
 * The ordering below is the design, not a convenience.
 *
 *   1. Quote through `quote()` on a staticcall. It is non `view` in the implementation and `view` in
 *      `ISwapVM`, which is what `asView()` exists to express, so an `eth_call` is the honest way to read it.
 *      Instruction `0x92` runs inside that call and clamps the quotable balance to what the position can
 *      genuinely release, so the number that comes back is already the truthful one.
 *   2. Size the unwind from the `amountOut` that quote returned, not from the input amount and not from a
 *      guess. `liquidityPercentageToDecrease` is an integer in [1, 100], so the percentage is rounded UP and
 *      the surplus stays in the vault as float. A just in time withdrawal can never be exact, and pretending
 *      otherwise would put the fill one wei short of the hook's floor check.
 *   3. `POST /lp/decrease` for that percentage and `POST /lp/increase` for the redeposit. Both are built by
 *      the API against live chain state, which is why they cannot be baked into the immutable order and have
 *      to travel with the taker.
 *   4. Encode the taker traits in Solidity, in `contracts/script/Fill.s.sol`, using the sponsor's own
 *      `TakerTraitsLib.build`. See that file for why this is not done here.
 *   5. Send `swap()` from the taker EOA, which must have approved the router for `tokenIn`.
 *   6. Read the receipt back and prove the claim: a `Swapped` event, and two PositionManager calls in the
 *      same transaction.
 *
 * Two failure modes are worth recognising on sight. An Aqua shortfall surfaces as `ERC20InsufficientBalance`
 * from the token rather than as an Aqua error, because `Aqua.pull` decrements the virtual balance first and
 * calls `safeTransferFrom` afterwards. A misaligned taker traits header surfaces as
 * `TakerTraitsAmountOutMustBeGreaterThanZero`, because a wrong slice index decodes a different slice rather
 * than failing to decode.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import { SEPOLIA, env } from './config.js'
import {
  FILL_REQUEST_PATH,
  FILL_REQUEST_RELATIVE,
  loadStrategy,
  readDeployments,
  writeDeployments,
} from './strategy.js'
import { UniswapClient } from './uniswap.js'

const ROOT = resolve(import.meta.dirname, '../..')

/** Default clip, in whole tokens of the input side. Override with `--amount=`. */
const DEFAULT_AMOUNT = 1_000n

/**
 * Margin added on top of the exact percentage before rounding up.
 *
 * The instruction values a unit of position liquidity with the maker's conservative conversion factor and
 * does not reproduce v4 tick math, so the amount a withdrawal actually releases can differ slightly from the
 * linear estimate. The vault's first guard is a floor on the realised delta, `outAfter >= outBefore +
 * amountOut`, and it is checked after the payload has run, so being one percent short there costs a reverted
 * fill. Five percent here is the same margin as the maker's haircut and it cannot push the request past the
 * cap: the instruction has already clamped `amountOut` to 23.75% of the position, and 23.75 x 1.05 rounds to
 * 25, which is exactly `maxUnwindPct`.
 */
const UNWIND_SAFETY = 0.05

/**
 * Share of the free float the redeposit puts back to work.
 *
 * The remainder absorbs the difference between what the API quotes for the redeposit and what the position
 * manager actually settles at the current price. A redeposit that asks for more than the vault holds reverts
 * the whole fill inside Permit2, so this errs downward on purpose and leaves a little dust behind.
 */
const REDEPOSIT_SHARE = 98n

/** Slippage floor on the fill itself, in basis points below the quote. */
const FILL_SLIPPAGE_BPS = 50n

const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
])

const routerAbi = parseAbi([
  'struct Order { address maker; uint256 traits; bytes data; }',
  'function quote(Order order, uint256 amount, bytes takerTraitsAndData) view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
  'event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)',
])

const vaultAbi = parseAbi([
  'function reachableFromPosition() view returns (uint256)',
  'event Unwound(bytes32 indexed orderHash, address indexed token, uint256 released, uint256 required)',
  'event Redeposited(bytes32 indexed orderHash, uint256 liquidityBefore, uint256 liquidityAfter)',
])

const poolManagerAbi = parseAbi([
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
])

const posmAbi = parseAbi(['function getPositionLiquidity(uint256 tokenId) view returns (uint128)'])

const aquaAbi = parseAbi([
  'function safeBalances(address maker, address app, bytes32 strategyHash, address token0, address token1) view returns (uint256, uint256)',
])

const step = (n: number, label: string) => console.log(`\n[${n}] ${label}`)
const info = (label: string, value: unknown = '') => console.log(`    ${label}${value === '' ? '' : `  ${value}`}`)

/**
 * The 22 byte taker traits header for a quote, which is the degenerate case of `TakerTraitsLib.build`.
 *
 * A quote carries no threshold, no recipient, no deadline, no hook data and no instruction arguments, so all
 * ten slice indexes are zero and the header collapses to twenty zero bytes followed by the flag word. That is
 * the one shape with no arithmetic in it, which is why it is safe to write here while the fill's header, whose
 * indexes are running sums over four payloads, is built by the sponsor's own library in Solidity.
 *
 * Only `isExactIn` and `isAToB` reach the VM, so this quotes exactly what the fill will execute.
 */
const IS_EXACT_IN_BIT_FLAG = 0x0001
const IS_A_TO_B_BIT_FLAG = 0x0080

function quoteTakerTraits(options: { isExactIn: boolean; isAToB: boolean }): Hex {
  const flags = (options.isExactIn ? IS_EXACT_IN_BIT_FLAG : 0) | (options.isAToB ? IS_A_TO_B_BIT_FLAG : 0)
  return `0x${'00'.repeat(20)}${flags.toString(16).padStart(4, '0')}`
}

/** `--amount=250` means 250 whole tokens of the input side. */
function parseAmountArg(): bigint {
  const raw = process.argv.find((arg) => arg.startsWith('--amount='))?.slice(9)
  if (!raw) return DEFAULT_AMOUNT * 10n ** 18n
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`--amount must be a positive decimal number, got ${raw}`)
  const [whole, fraction = ''] = raw.split('.')
  return BigInt(whole + fraction.padEnd(18, '0').slice(0, 18))
}

const tokens = (amount: bigint, symbol: string) => `${formatUnits(amount, 18)} ${symbol}`

async function main() {
  const deployments = readDeployments()
  const strategy = loadStrategy(deployments)
  const account = privateKeyToAccount(env.privateKey as Hex)
  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.rpcUrl) })
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(env.rpcUrl) })
  const uniswap = new UniswapClient({ apiKey: env.apiKey, chainId: SEPOLIA.chainId, protocol: 'V4' })

  const router = getAddress(deployments.router)
  const vault = strategy.params.vault
  const positionManager = strategy.params.positionManager
  const poolManager = getAddress(SEPOLIA.poolManager)
  const aqua = getAddress(deployments.aqua)
  const tokenId = strategy.params.tokenId
  const { token0, token1 } = strategy

  // `isAToB` reads the order's two tokens in the sorted order they are stored in, so token A is token0.
  // The taker pays token0 and is paid token1.
  const isAToB = true
  const [tokenIn, tokenOut] = isAToB ? [token0, token1] : [token1, token0]
  const amount = parseAmountArg()

  const [symbolIn, symbolOut] = await Promise.all([
    publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({ address: tokenOut, abi: erc20Abi, functionName: 'symbol' }),
  ])

  console.log('\nBebecita fill, Ethereum Sepolia')
  info('taker           ', account.address)
  info('maker (vault)   ', vault)
  info('router          ', router)
  info('orderHash       ', strategy.orderHash)
  info('direction       ', `${symbolIn} in, ${symbolOut} out`)
  info('clip            ', tokens(amount, symbolIn))

  // The strategy has to still be open, and a docked or never shipped one reverts inside Aqua with a message
  // that says nothing about salts. Checking here costs one call and turns that into a sentence.
  const [aquaBalance0, aquaBalance1] = await publicClient
    .readContract({
      address: aqua,
      abi: aquaAbi,
      functionName: 'safeBalances',
      args: [vault, router, strategy.orderHash, token0, token1],
    })
    .catch(() => {
      throw new Error(
        `Aqua has no active strategy ${strategy.orderHash} for maker ${vault}. A strategy hash can be ` +
          'shipped exactly once ever, so run yarn demo:reset to re-salt and re-ship it.',
      )
    })
  info('aqua balances   ', `${formatUnits(aquaBalance0, 18)} / ${formatUnits(aquaBalance1, 18)}`)

  // -------------------------------------------------------------------
  step(1, 'quote() through a staticcall, which is what asView() is for')
  // -------------------------------------------------------------------

  const takerTraitsForQuote = quoteTakerTraits({ isExactIn: true, isAToB })
  const [quotedIn, quotedOut, quotedHash] = await publicClient.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'quote',
    args: [
      { maker: strategy.order.maker, traits: strategy.order.traits, data: strategy.order.data },
      amount,
      takerTraitsForQuote,
    ],
  })

  if (quotedHash !== strategy.orderHash) {
    throw new Error(`router.quote reports order hash ${quotedHash}, the shipped one is ${strategy.orderHash}`)
  }
  if (quotedOut === 0n) throw new Error('the book quoted nothing, there is no fill to make')

  info('amountIn        ', tokens(quotedIn, symbolIn))
  info('amountOut       ', tokens(quotedOut, symbolOut))
  info('price           ', `${formatUnits((quotedOut * 10n ** 18n) / quotedIn, 18)} ${symbolOut} per ${symbolIn}`)

  const amountOutMin = (quotedOut * (10_000n - FILL_SLIPPAGE_BPS)) / 10_000n
  info('amountOutMin    ', `${tokens(amountOutMin, symbolOut)}, ${FILL_SLIPPAGE_BPS} bps below the quote`)

  // -------------------------------------------------------------------
  step(2, 'size the unwind from amountOut, and round the percentage up')
  // -------------------------------------------------------------------

  const liquidity = await publicClient.readContract({
    address: positionManager,
    abi: posmAbi,
    functionName: 'getPositionLiquidity',
    args: [tokenId],
  })
  if (liquidity === 0n) throw new Error(`position ${tokenId} carries no liquidity, there is nothing to unwind`)

  const [floatIn, floatOut, reachable] = await Promise.all([
    publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'balanceOf', args: [vault] }),
    publicClient.readContract({ address: tokenOut, abi: erc20Abi, functionName: 'balanceOf', args: [vault] }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'reachableFromPosition' }),
  ])

  // The maker's own conversion factor, the same one instruction 0x92 and the vault's guards read.
  const deployed = (liquidity * strategy.params.unitsPerLiquidityE18) / 10n ** 18n

  // The vault's first guard is a delta check, `outAfter >= outBefore + amountOut`, so the float already in the
  // vault does not count towards it. The withdrawal alone has to release the whole payout.
  const exactPct = (Number((quotedOut * 10n ** 12n) / deployed) / 1e12) * 100
  const percent = Math.max(1, Math.ceil(exactPct * (1 + UNWIND_SAFETY)))

  info('position        ', `tokenId ${tokenId}, liquidity ${liquidity}`)
  info('deployed        ', `${tokens(deployed, symbolOut)} per side at the maker's conversion factor`)
  info('reachable       ', `${tokens(reachable, symbolOut)} after the ${strategy.params.maxUnwindPct}% cap and the haircut`)
  info('vault float     ', `${tokens(floatIn, symbolIn)} / ${tokens(floatOut, symbolOut)}`)
  info('exact unwind    ', `${exactPct.toFixed(6)}% of the position`)
  info('requested       ', `${percent}%, rounded up because liquidityPercentageToDecrease is an integer`)

  if (percent > strategy.params.maxUnwindPct) {
    throw new Error(
      `sizing wants ${percent}% of the position and the maker authorised ${strategy.params.maxUnwindPct}%. ` +
        'Instruction 0x92 should have clamped the quote below that, so this means the order and the vault ' +
        'disagree on the risk parameters.',
    )
  }

  // -------------------------------------------------------------------
  step(3, 'POST /lp/decrease for the unwind, POST /lp/increase for the redeposit')
  // -------------------------------------------------------------------

  const decrease = await uniswap.decrease({
    walletAddress: vault,
    tokenId: tokenId.toString(),
    token0,
    token1,
    percent,
  })
  const released0 = BigInt((decrease.token0 as { amount: string }).amount)
  const released1 = BigInt((decrease.token1 as { amount: string }).amount)
  const [releasedIn, releasedOut] = isAToB ? [released0, released1] : [released1, released0]
  const decreaseCalldata = decrease.decrease.data as Hex

  info('/lp/decrease    ', `${percent}% -> ${tokens(releasedIn, symbolIn)} + ${tokens(releasedOut, symbolOut)}`)
  info('target          ', decrease.decrease.to)
  info('calldata        ', `${(decreaseCalldata.length - 2) / 2} bytes`)

  if (releasedOut < quotedOut) {
    throw new Error(
      `${percent}% of the position releases ${formatUnits(releasedOut, 18)} ${symbolOut} and the fill owes ` +
        `${formatUnits(quotedOut, 18)}. The vault's floor check would revert, so the sizing is wrong.`,
    )
  }
  const surplus = releasedOut - quotedOut
  info('surplus float   ', `${tokens(surplus, symbolOut)} stays in the vault, the cost of an integer percentage`)

  // What the vault will hold when `postTransferIn` runs. The pull has already paid the taker by then, and the
  // push has already credited the vault with the taker's input, which is exactly why the redeposit can be two
  // sided at all.
  const availableOut = floatOut + releasedOut - quotedOut
  const availableIn = floatIn + releasedIn + quotedIn
  const redeposit = ((availableOut < availableIn ? availableOut : availableIn) * REDEPOSIT_SHARE) / 100n
  if (redeposit === 0n) throw new Error('nothing left to redeposit after the fill, the sizing is wrong')

  const increase = await uniswap.increase({
    walletAddress: vault,
    tokenId: tokenId.toString(),
    token0,
    token1,
    independentToken: tokenOut,
    independentAmount: redeposit.toString(),
  })
  const increaseCalldata = increase.increase.data as Hex

  info('after the pull  ', `${tokens(availableIn, symbolIn)} / ${tokens(availableOut, symbolOut)} in the vault`)
  info('/lp/increase    ', `${tokens(redeposit, symbolOut)} named, the API computes the other leg`)
  info('target          ', increase.increase.to)
  info('calldata        ', `${(increaseCalldata.length - 2) / 2} bytes`)
  info('api quota left  ', uniswap.remainingQuota ?? 'n/a')

  if (getAddress(decrease.decrease.to) !== positionManager || getAddress(increase.increase.to) !== positionManager) {
    throw new Error('the API built calldata for a contract other than the pinned position manager')
  }

  // -------------------------------------------------------------------
  step(4, 'approve the router for the input token, once')
  // -------------------------------------------------------------------

  const allowance = await publicClient.readContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, router],
  })

  if (allowance < quotedIn) {
    // `useTransferFromAndAquaPush` makes the router pull the input from the taker and push it into Aqua on
    // the taker's behalf, so the approval goes to the router and not to Aqua.
    const hash = await wallet.writeContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: 'approve',
      args: [router, 2n ** 256n - 1n],
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`approve reverted, ${hash}`)
    info('approved        ', `${symbolIn} -> router  ${hash}`)
  } else {
    info('already approved', `${symbolIn} -> router`)
  }

  const takerBalance = await publicClient.readContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })
  if (takerBalance < quotedIn) {
    throw new Error(`taker holds ${formatUnits(takerBalance, 18)} ${symbolIn} and the fill needs ${formatUnits(quotedIn, 18)}`)
  }

  // -------------------------------------------------------------------
  step(5, 'encode the taker traits in Solidity and send swap()')
  // -------------------------------------------------------------------

  const request = {
    router,
    taker: account.address,
    positionManager,
    tokenIn,
    tokenOut,
    amount: amount.toString(),
    amountOutMin: amountOutMin.toString(),
    unwindPercent: percent,
    order: {
      maker: strategy.order.maker,
      traits: strategy.order.traits.toString(),
      data: strategy.order.data,
    },
    decreaseCalldata,
    increaseCalldata,
  }
  writeFileSync(FILL_REQUEST_PATH, `${JSON.stringify(request, null, 2)}\n`)
  info('handover file   ', FILL_REQUEST_RELATIVE)

  // The script asserts the two position manager calls with `vm.expectCall` before it broadcasts anything, so
  // reaching the next line already means the claim held in simulation. The count below is read off the trace
  // for the demo, not to decide anything.
  const dryRun = process.argv.includes('--dry')
  const trace = runFillScript({ broadcast: !dryRun })
  const positionManagerCalls = countPositionManagerCalls(trace, positionManager)
  info('simulated trace ', `${positionManagerCalls} modifyLiquidities calls to ${positionManager}`)

  if (dryRun) {
    console.log('\nDry run only. The same command without --dry broadcasts it.\n')
    return
  }

  const txHash = readBroadcastHash()
  info('transaction     ', txHash)

  // -------------------------------------------------------------------
  step(6, 'read the receipt back')
  // -------------------------------------------------------------------

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') {
    throw new Error(`the fill reverted, ${txHash}. Read the trace above, not the status.`)
  }
  info('status          ', `success, block ${receipt.blockNumber}, gas ${receipt.gasUsed}`)

  const swapped = parseEventLogs({ abi: routerAbi, eventName: 'Swapped', logs: receipt.logs })
    .filter((log) => getAddress(log.address) === router)
    .at(0)
  if (!swapped) throw new Error('no Swapped event in the receipt, which cannot happen on a successful swap')

  console.log('\n    Swapped')
  info('  orderHash     ', swapped.args.orderHash)
  info('  maker         ', swapped.args.maker)
  info('  taker         ', swapped.args.taker)
  info('  tokenIn       ', `${swapped.args.tokenIn}  ${tokens(swapped.args.amountIn, symbolIn)}`)
  info('  tokenOut      ', `${swapped.args.tokenOut}  ${tokens(swapped.args.amountOut, symbolOut)}`)

  const vaultLogs = receipt.logs.filter((log) => getAddress(log.address) === vault)
  const unwound = parseEventLogs({ abi: vaultAbi, eventName: 'Unwound', logs: vaultLogs }).at(0)
  const redeposited = parseEventLogs({ abi: vaultAbi, eventName: 'Redeposited', logs: vaultLogs }).at(0)
  const modifyLiquidity = parseEventLogs({
    abi: poolManagerAbi,
    eventName: 'ModifyLiquidity',
    logs: receipt.logs.filter((log) => getAddress(log.address) === poolManager),
  })

  console.log('\n    Two PositionManager calls, in the same transaction')
  if (!unwound) throw new Error('no Unwound event, the preTransferOut hook did not execute the unwind')
  info('  preTransferOut', `released ${tokens(unwound.args.released, symbolOut)} against ${tokens(unwound.args.required, symbolOut)} owed`)
  if (!redeposited) throw new Error('no Redeposited event, the postTransferIn hook did not execute the redeposit')
  info('  postTransferIn', `liquidity ${redeposited.args.liquidityBefore} -> ${redeposited.args.liquidityAfter}`)

  if (modifyLiquidity.length !== 2) {
    throw new Error(
      `the PoolManager emitted ${modifyLiquidity.length} ModifyLiquidity events, one fill must produce ` +
        'exactly two, the unwind and the redeposit',
    )
  }
  for (const [index, log] of modifyLiquidity.entries()) {
    const kind = log.args.liquidityDelta < 0n ? 'decrease' : 'increase'
    info(`  poolManager ${index + 1} `, `${kind}, liquidityDelta ${log.args.liquidityDelta}, sender ${getAddress(log.args.sender)}`)
    if (getAddress(log.args.sender) !== positionManager) {
      throw new Error(`ModifyLiquidity came from ${log.args.sender}, expected the position manager`)
    }
  }
  info('  simulated trace', `${positionManagerCalls} modifyLiquidities calls to ${positionManager}`)

  const liquidityAfter = await publicClient.readContract({
    address: positionManager,
    abi: posmAbi,
    functionName: 'getPositionLiquidity',
    args: [tokenId],
  })
  const floatAfter = await publicClient.readContract({
    address: tokenOut,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [vault],
  })
  info('  position now  ', `${liquidityAfter}, was ${liquidity}`)
  info('  vault float   ', tokens(floatAfter, symbolOut))

  deployments.lastFill = {
    txHash,
    orderHash: strategy.orderHash,
    amountIn: swapped.args.amountIn.toString(),
    amountOut: swapped.args.amountOut.toString(),
    tokenIn,
    tokenOut,
    unwindPercent: percent,
    gasUsed: receipt.gasUsed.toString(),
    blockNumber: receipt.blockNumber.toString(),
  }
  writeDeployments(deployments)

  console.log(`\nFilled. https://sepolia.etherscan.io/tx/${txHash}\n`)
}

/**
 * Runs the Foundry script that encodes the traits and broadcasts, and returns its output.
 *
 * `--skip test` is not optional: `via_ir` makes a full build cost close to four minutes and the test suite is
 * not needed to send one transaction. `-vvvv` is what makes the simulated call trace available, which is the
 * only trace we get, because the public Sepolia endpoints answer `debug_traceTransaction` with a 403 and
 * `cast run` needs an archive node.
 */
function runFillScript(options: { broadcast: boolean }): string {
  const args = ['script', 'contracts/script/Fill.s.sol', '--rpc-url', env.rpcUrl, '--skip', 'test', '-vvvv']
  if (options.broadcast) args.push('--broadcast')

  const output = execFileSync('forge', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env },
  })

  // The interesting half is the trace and the amounts. The rest is compiler and broadcast bookkeeping.
  for (const line of output.split('\n')) {
    if (/^\s{2}(router|taker|amount|decrease|increase|orderHash|amountIn|amountOut|taker traits)/.test(line)) {
      console.log(`    ${line.trim()}`)
    }
  }
  return output
}

/**
 * Distinct `modifyLiquidities` payloads sent to the position manager, read off the simulated call trace.
 *
 * Two details make the naive grep wrong. Foundry prints the whole trace twice under `--broadcast`, once for
 * the simulation and once for the run, so calls are counted by payload rather than by line. And the address of
 * the position manager also appears inside the order data, because the instruction's arguments name it, so the
 * match is anchored on the `::selector(` form rather than on the address appearing anywhere in the line.
 */
function countPositionManagerCalls(trace: string, positionManager: Address): number {
  const call = new RegExp(
    `(?:positionmanager|${positionManager.toLowerCase()})::(?:modifyliquidities|(?:0x)?dd46508f)\\((0x[0-9a-f]+)`,
  )
  const payloads = new Set<string>()
  for (const line of trace.split('\n')) {
    const payload = line.toLowerCase().match(call)?.[1]
    if (payload) payloads.add(payload)
  }
  return payloads.size
}

/** The hash of the transaction the script just broadcast. */
function readBroadcastHash(): Hex {
  const path = resolve(ROOT, `broadcast/Fill.s.sol/${SEPOLIA.chainId}/run-latest.json`)
  const run = JSON.parse(readFileSync(path, 'utf8')) as {
    transactions: { hash?: string; transaction?: { to?: string } }[]
  }
  const sent = run.transactions.filter((tx) => tx.hash)
  if (sent.length !== 1) {
    throw new Error(`expected exactly one broadcast transaction, the run recorded ${sent.length}`)
  }
  return sent[0]!.hash as Hex
}

main().catch((error) => {
  console.error(`\n${error}`)
  process.exit(1)
})
