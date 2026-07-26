/**
 * One complete fill on Ethereum Sepolia, funded by unwinding the Uniswap position inside the same transaction.
 *
 * Run with `yarn fill`, after `yarn setup` and `yarn aqua`. This is the whole product in one command: it
 * quotes the book, sizes the withdrawal from that quote, asks the Uniswap API for the two payloads, encodes
 * the taker traits and sends the swap from the taker's own key.
 *
 * The decisions all live in `solver/src/fillPlan.ts`, which is the same module the browser runs. This file is
 * the terminal half of it: a viem transport for the reads, an `x-api-key` header on the two API calls, a
 * private key on the broadcast. `app/src/lib/fill.ts` is the other half, with the connected wallet in place of
 * the key, and there is no third copy of the sizing arithmetic anywhere.
 *
 * The taker traits are built by `solver/src/takerTraits.ts`, a port of the sponsor's `TakerTraitsLib.build`
 * proved byte for byte against it in `contracts/test/TakerTraits.t.sol`. `contracts/script/Fill.s.sol` is the
 * Solidity reference that test diffs against, and this command still writes the handover file that script
 * reads, so the same fill can be replayed through Foundry when a trace is wanted.
 */
import { writeFileSync } from 'node:fs'

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
import { planFill, type ChainReader, type LiquidityApi } from './fillPlan.js'
import {
  FILL_REQUEST_PATH,
  FILL_REQUEST_RELATIVE,
  loadStrategy,
  readDeployments,
  writeDeployments,
} from './strategy.js'
import { UniswapClient } from './uniswap.js'

/** Default clip, in whole tokens of the input side. Override with `--amount=`. */
const DEFAULT_AMOUNT = 1_000n

const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
])

const routerAbi = parseAbi([
  'struct Order { address maker; uint256 traits; bytes data; }',
  'function quote(Order order, uint256 amount, bytes takerTraitsAndData) view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
  'function swap(Order order, uint256 amount, bytes takerTraitsAndData) payable returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)',
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
  const amount = parseAmountArg()
  const dryRun = process.argv.includes('--dry')

  /** The chain half of the plan's environment: four view calls, nothing else. */
  const chain: ChainReader = {
    quote: async ({ order, amount: quoteAmount, takerTraitsAndData }) => {
      const [amountIn, amountOut, orderHash] = await publicClient.readContract({
        address: router,
        abi: routerAbi,
        functionName: 'quote',
        args: [order, quoteAmount, takerTraitsAndData],
      })
      return { amountIn, amountOut, orderHash }
    },
    positionLiquidity: async (id) =>
      publicClient.readContract({
        address: positionManager,
        abi: posmAbi,
        functionName: 'getPositionLiquidity',
        args: [id],
      }),
    balanceOf: async (token, owner) =>
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    reachableFromPosition: async (maker) =>
      publicClient.readContract({ address: maker, abi: vaultAbi, functionName: 'reachableFromPosition' }),
  }

  /** The API half. The browser implements the same two methods through the dev server proxy. */
  const api: LiquidityApi = {
    decrease: async (params) => {
      const response = await uniswap.decrease({
        walletAddress: params.walletAddress,
        tokenId: params.tokenId.toString(),
        token0: params.token0,
        token1: params.token1,
        percent: params.percent,
      })
      return {
        to: getAddress(response.decrease.to),
        data: response.decrease.data as Hex,
        amount0: BigInt((response.token0 as { amount: string }).amount),
        amount1: BigInt((response.token1 as { amount: string }).amount),
      }
    },
    increase: async (params) => {
      const response = await uniswap.increase({
        walletAddress: params.walletAddress,
        tokenId: params.tokenId.toString(),
        token0: params.token0,
        token1: params.token1,
        independentToken: params.independentToken,
        independentAmount: params.independentAmount.toString(),
      })
      return { to: getAddress(response.increase.to), data: response.increase.data as Hex }
    },
  }

  const [symbolIn, symbolOut] = await Promise.all([
    publicClient.readContract({
      address: isAToB ? token0 : token1,
      abi: erc20Abi,
      functionName: 'symbol',
    }),
    publicClient.readContract({
      address: isAToB ? token1 : token0,
      abi: erc20Abi,
      functionName: 'symbol',
    }),
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

  const plan = await planFill(chain, api, {
    order: strategy.order,
    orderHash: strategy.orderHash,
    taker: account.address,
    vault,
    positionManager,
    tokenId,
    token0,
    token1,
    isAToB,
    amount,
    unitsPerLiquidityE18: strategy.params.unitsPerLiquidityE18,
    maxUnwindPct: strategy.params.maxUnwindPct,
    haircutBps: strategy.params.haircutBps,
    onStep: ({ index, label }) => step(index, label),
  })

  info('amountIn        ', tokens(plan.quotedIn, symbolIn))
  info('amountOut       ', tokens(plan.quotedOut, symbolOut))
  info('price           ', `${formatUnits((plan.quotedOut * 10n ** 18n) / plan.quotedIn, 18)} ${symbolOut} per ${symbolIn}`)
  info('amountOutMin    ', tokens(plan.amountOutMin, symbolOut))
  info('position        ', `tokenId ${tokenId}, liquidity ${plan.liquidity}`)
  info('deployed        ', `${tokens(plan.deployed, symbolOut)} per side at the maker's conversion factor`)
  info('reachable       ', `${tokens(plan.reachable, symbolOut)} after the ${strategy.params.maxUnwindPct}% cap and the haircut`)
  info('vault float     ', `${tokens(plan.floatIn, symbolIn)} / ${tokens(plan.floatOut, symbolOut)}`)
  info('exact unwind    ', `${plan.exactPct.toFixed(6)}% of the position`)
  info('requested       ', `${plan.unwindPercent}%, rounded up because liquidityPercentageToDecrease is an integer`)
  info('/lp/decrease    ', `${plan.unwindPercent}% -> ${tokens(plan.releasedIn, symbolIn)} + ${tokens(plan.releasedOut, symbolOut)}`)
  info('calldata        ', `${(plan.decreaseCalldata.length - 2) / 2} bytes`)
  info('surplus float   ', `${tokens(plan.surplus, symbolOut)} stays in the vault, the cost of an integer percentage`)
  info(
    '/lp/increase    ',
    `${tokens(plan.redeposit, plan.redepositToken === plan.tokenOut ? symbolOut : symbolIn)} named on the side ` +
      "the pool's ratio makes scarce, the API computes the other leg",
  )
  info('calldata        ', `${(plan.increaseCalldata.length - 2) / 2} bytes`)
  info('taker traits    ', `${(plan.takerTraitsAndData.length - 2) / 2} bytes`)
  info('api quota left  ', uniswap.remainingQuota ?? 'n/a')

  // The same request the Solidity reference in `contracts/script/Fill.s.sol` reads, so this fill can be
  // replayed through Foundry when a call trace is wanted. Nothing on this path depends on it.
  writeFileSync(
    FILL_REQUEST_PATH,
    `${JSON.stringify(
      {
        router,
        taker: account.address,
        positionManager,
        tokenIn: plan.tokenIn,
        tokenOut: plan.tokenOut,
        amount: amount.toString(),
        amountOutMin: plan.amountOutMin.toString(),
        unwindPercent: plan.unwindPercent,
        order: {
          maker: strategy.order.maker,
          traits: strategy.order.traits.toString(),
          data: strategy.order.data,
        },
        decreaseCalldata: plan.decreaseCalldata,
        increaseCalldata: plan.increaseCalldata,
        takerTraitsAndData: plan.takerTraitsAndData,
      },
      null,
      2,
    )}\n`,
  )
  info('handover file   ', `${FILL_REQUEST_RELATIVE}, replayable with contracts/script/Fill.s.sol`)

  // -------------------------------------------------------------------
  step(5, 'approve the router for the input token, once')
  // -------------------------------------------------------------------

  const [allowance, takerBalance] = await Promise.all([
    publicClient.readContract({
      address: plan.tokenIn,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, router],
    }),
    publicClient.readContract({
      address: plan.tokenIn,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    }),
  ])

  if (takerBalance < plan.quotedIn) {
    throw new Error(
      `taker holds ${formatUnits(takerBalance, 18)} ${symbolIn} and the fill needs ${formatUnits(plan.quotedIn, 18)}. ` +
        'TestERC20.mint is public, so any address can fund itself.',
    )
  }

  if (allowance < plan.quotedIn) {
    // `useTransferFromAndAquaPush` makes the router pull the input from the taker and push it into Aqua on
    // the taker's behalf, so the approval goes to the router and not to Aqua.
    const hash = await wallet.writeContract({
      address: plan.tokenIn,
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

  // -------------------------------------------------------------------
  step(6, 'simulate, then send swap()')
  // -------------------------------------------------------------------

  const swapArgs = {
    address: router,
    abi: routerAbi,
    functionName: 'swap',
    args: [plan.order, amount, plan.takerTraitsAndData],
    account,
  } as const

  // The simulation runs the whole program against live state and reverts with the VM's own error when the
  // fill cannot settle, which is worth having before a nonce is spent.
  const { result } = await publicClient.simulateContract(swapArgs)
  const [simulatedIn, simulatedOut, simulatedHash] = result
  info('simulated       ', `${tokens(simulatedIn, symbolIn)} in, ${tokens(simulatedOut, symbolOut)} out`)
  info('orderHash       ', simulatedHash)

  if (dryRun) {
    console.log('\nDry run only. The same command without --dry broadcasts it.\n')
    return
  }

  const txHash = await wallet.writeContract(swapArgs)
  info('transaction     ', txHash)

  // -------------------------------------------------------------------
  step(7, 'read the receipt back')
  // -------------------------------------------------------------------

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') {
    throw new Error(`the fill reverted, ${txHash}. Read the trace on Etherscan, not the status.`)
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

  const [liquidityAfter, floatAfter] = await Promise.all([
    publicClient.readContract({
      address: positionManager,
      abi: posmAbi,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: plan.tokenOut,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [vault],
    }),
  ])
  info('  position now  ', `${liquidityAfter}, was ${plan.liquidity}`)
  info('  vault float   ', tokens(floatAfter, symbolOut))

  deployments.lastFill = {
    txHash,
    orderHash: strategy.orderHash,
    amountIn: swapped.args.amountIn.toString(),
    amountOut: swapped.args.amountOut.toString(),
    tokenIn: plan.tokenIn,
    tokenOut: plan.tokenOut,
    unwindPercent: plan.unwindPercent,
    gasUsed: receipt.gasUsed.toString(),
    blockNumber: receipt.blockNumber.toString(),
  }
  writeDeployments(deployments)

  console.log(`\nFilled. https://sepolia.etherscan.io/tx/${txHash}\n`)
}

main().catch((error) => {
  console.error(`\n${error}`)
  process.exit(1)
})
