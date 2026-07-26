import type { Address, Hex, WalletClient } from 'viem'

import { planFill, type ChainReader, type FillPlan, type LiquidityApi } from '@solver/fillPlan'
import { erc20Abi, positionManagerAbi, routerAbi, vaultAbi } from './abi'
import { CHAIN, publicClient } from './client'
import { reason } from './format'
import { readFillReceipt, type FillReceipt } from './receipt'
import { decrease, increase } from './uniswap'

/**
 * The fill, in the tab, signed by the connected wallet.
 *
 * There is no backend. The taker traits are encoded by `solver/src/takerTraits.ts`, a port of the sponsor's
 * `TakerTraitsLib.build` that `contracts/test/TakerTraits.t.sol` proves byte for byte against the library
 * itself, and the sizing is `solver/src/fillPlan.ts`, the same module `yarn fill` runs. This file is only the
 * browser's half of the environment those two need: reads through viem, the two Uniswap calls through the dev
 * server proxy that holds the API key, and `swap()` through the wallet client wagmi hands back, which is a
 * viem client over whichever connector is connected.
 *
 * The connected wallet is the taker, which is what makes the demo self serve. It needs the input token and an
 * allowance to the router, and both are one button away because `TestERC20.mint` is public.
 */

export interface FillRequest {
  /** Taker amount in the smallest unit. Exact in, so this is what the taker pays. */
  amount: bigint
  /** True means token0 in and token1 out, matching the `IS_A_TO_B` taker trait. */
  isAToB: boolean
  /** The connected wallet. It signs the swap and it is the address the router pulls the input from. */
  taker: Address
  /**
   * The viem client wagmi built over the connected connector. Only `swap()` goes through it, so a dry run
   * neither needs one nor is given one: it simulates on `publicClient`, which is pinned to Sepolia.
   */
  wallet: WalletClient | null
  order: { maker: Address; traits: bigint; data: Hex }
  orderHash?: Hex
  router: Address
  vault: Address
  positionManager: Address
  /** Where the two `ModifyLiquidity` events land. Only the receipt read-back needs it. */
  poolManager?: Address | null
  /** Narrows the read-back to this pool, for a PoolManager that carries more than one. */
  poolId?: Hex | null
  tokenId: bigint
  token0: Address
  token1: Address
  unitsPerLiquidityE18: bigint
  maxUnwindPct: number
  /** Read off the vault, like `maxUnwindPct`. The plan derives its unwind safety margin from it. */
  haircutBps: number
  chainId: number
  /** Simulate against live state and broadcast nothing. */
  dry?: boolean
  onEvent?: (event: FillEvent) => void
}

export interface FillStep {
  index: number
  label: string
  at: number
}

export type FillEvent =
  | { type: 'step'; index: number; label: string }
  | { type: 'log'; line: string }
  /** The hash, the instant the wallet returns it, so the page can link it before the block exists. */
  | { type: 'sent'; hash: Hex }
  | { type: 'error'; message: string }

export interface FillResult {
  /** Null on a dry run, which simulates against live state and broadcasts nothing. */
  transactionHash: Hex | null
  /** The block it landed in and what it cost, null on a dry run. */
  blockNumber: bigint | null
  gasUsed: bigint | null
  orderHash: Hex
  /**
   * What the taker paid and was paid.
   *
   * On a dry run these are the simulation's own figures, because nothing settled. On a real fill they are
   * overwritten by the `Swapped` event in the receipt, so the two numbers on screen are the ones the chain
   * recorded rather than the ones a simulation predicted one block earlier.
   */
  amountIn: bigint
  amountOut: bigint
  /** The two payloads the Uniswap API built for this fill, exactly as placed in the taker traits slices. */
  decreaseCalldata: Hex
  increaseCalldata: Hex
  takerTraitsAndData: Hex
  /** What the API was asked to unwind, rounded up, in percent. */
  unwindPercent: number
  /** The address that signed, which is the connected wallet. */
  taker: Address
  tokenIn: Address
  tokenOut: Address
  /**
   * The fill decoded out of its own logs. Null on a dry run, and null on a real fill whose read-back failed,
   * which is a state the panel says out loud rather than filling in from the request.
   */
  receipt: FillReceipt | null
  dry: boolean
  steps: FillStep[]
  log: string[]
}

/** Thrown when the taker cannot pay yet, with the button that fixes it named in the message. */
export class TakerNotFundedError extends Error {
  constructor(
    message: string,
    readonly need: { token: Address; amount: bigint; balance: bigint; allowance: bigint },
  ) {
    super(message)
    this.name = 'TakerNotFundedError'
  }
}

/** Chain reads, all `view`, answered by whichever endpoint the fallback transport reaches first. */
function chainReader(router: Address, positionManager: Address): ChainReader {
  return {
    quote: async ({ order, amount, takerTraitsAndData }) => {
      const [amountIn, amountOut, orderHash] = await publicClient.readContract({
        address: router,
        abi: routerAbi,
        functionName: 'quote',
        args: [order, amount, takerTraitsAndData],
      })
      return { amountIn, amountOut, orderHash }
    },
    positionLiquidity: async (tokenId) =>
      BigInt(
        await publicClient.readContract({
          address: positionManager,
          abi: positionManagerAbi,
          functionName: 'getPositionLiquidity',
          args: [tokenId],
        }),
      ),
    balanceOf: async (token, owner) =>
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    reachableFromPosition: async (vault) =>
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'reachableFromPosition' }),
  }
}

/**
 * The two Uniswap calls, from the tab.
 *
 * They go out through `/api/uniswap`, which is the dev server attaching `x-api-key` and forwarding to
 * `https://liquidity.api.uniswap.org`, so the key never reaches the bundle. The gateway also answers browser
 * preflights on those paths, so a build that carries its own key can call the host directly instead. Either
 * way the request leaves the browser and lands in the network panel with its response headers.
 */
function liquidityApi(chainId: number): LiquidityApi {
  return {
    decrease: async (params) => {
      const { payload } = await decrease({
        chainId,
        walletAddress: params.walletAddress,
        tokenId: params.tokenId.toString(),
        token0: params.token0,
        token1: params.token1,
        percent: params.percent,
      })
      const built = payload as {
        decrease?: { to?: string; data?: string }
        token0?: { amount?: string }
        token1?: { amount?: string }
      }
      if (!built.decrease?.to || !built.decrease.data) {
        throw new Error('/lp/decrease answered without a transaction request, so there is no unwind to place')
      }
      return {
        to: built.decrease.to as Address,
        data: built.decrease.data as Hex,
        amount0: BigInt(built.token0?.amount ?? 0),
        amount1: BigInt(built.token1?.amount ?? 0),
      }
    },
    increase: async (params) => {
      const { payload } = await increase({
        chainId,
        walletAddress: params.walletAddress,
        tokenId: params.tokenId.toString(),
        token0: params.token0,
        token1: params.token1,
        independentToken: params.independentToken,
        independentAmount: params.independentAmount.toString(),
      })
      const built = payload as { increase?: { to?: string; data?: string } }
      if (!built.increase?.to || !built.increase.data) {
        throw new Error('/lp/increase answered without a transaction request, so there is no redeposit to place')
      }
      return { to: built.increase.to as Address, data: built.increase.data as Hex }
    },
  }
}

/** What the taker must hold and must have approved before the swap can be signed. */
export async function readTakerPosition(params: {
  taker: Address
  token: Address
  router: Address
}): Promise<{ balance: bigint; allowance: bigint }> {
  const [balance, allowance] = await Promise.all([
    publicClient.readContract({
      address: params.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [params.taker],
    }),
    publicClient.readContract({
      address: params.token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [params.taker, params.router],
    }),
  ])
  return { balance, allowance }
}

/** Mints `TestERC20` to the connected wallet. Public on the token, which is what makes the demo self serve. */
export async function mintTo(params: {
  wallet: WalletClient
  token: Address
  taker: Address
  amount: bigint
}): Promise<Hex> {
  return params.wallet.writeContract({
    account: params.taker,
    chain: CHAIN,
    address: params.token,
    abi: erc20Abi,
    functionName: 'mint',
    args: [params.taker, params.amount],
  })
}

/**
 * Approves the router for the input token.
 *
 * The router and not Aqua: `useTransferFromAndAquaPush` is set, so the router pulls `tokenIn` from the taker
 * and pushes it into Aqua on the taker's behalf. An allowance to Aqua would leave the swap reverting inside
 * the push with an ERC20 error naming neither contract.
 */
export async function approveRouter(params: {
  wallet: WalletClient
  token: Address
  taker: Address
  router: Address
  amount?: bigint
}): Promise<Hex> {
  return params.wallet.writeContract({
    account: params.taker,
    chain: CHAIN,
    address: params.token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [params.router, params.amount ?? 2n ** 256n - 1n],
  })
}

/**
 * Quote, size, fetch, encode, sign, broadcast, read back. The whole fill, in the tab.
 *
 * The plan is built first and is read only, so nothing is signed until the two Uniswap payloads exist and the
 * taker traits have been encoded. The swap is then simulated against live state, which is what turns a VM
 * revert into a message before a nonce is spent, and only then handed to the wallet. What comes back out is
 * decoded from the receipt's own logs by `receipt.ts`, so the figures shown are the chain's and not this
 * module's.
 */
export async function runFill(request: FillRequest): Promise<FillResult> {
  const steps: FillStep[] = []
  const log: string[] = []
  const emit = (event: FillEvent) => {
    if (event.type === 'step') steps.push({ index: event.index, label: event.label, at: Date.now() })
    if (event.type === 'log') log.push(event.line)
    request.onEvent?.(event)
  }

  const plan: FillPlan = await planFill(
    chainReader(request.router, request.positionManager),
    liquidityApi(request.chainId),
    {
      order: request.order,
      orderHash: request.orderHash,
      taker: request.taker,
      vault: request.vault,
      positionManager: request.positionManager,
      tokenId: request.tokenId,
      token0: request.token0,
      token1: request.token1,
      isAToB: request.isAToB,
      amount: request.amount,
      unitsPerLiquidityE18: request.unitsPerLiquidityE18,
      maxUnwindPct: request.maxUnwindPct,
      haircutBps: request.haircutBps,
      onStep: ({ index, label }) => emit({ type: 'step', index, label }),
      onInfo: (label, value) => emit({ type: 'log', line: `${label}  ${value}` }),
    },
  )

  emit({ type: 'step', index: 5, label: 'check the taker can pay, then sign swap() with the connected wallet' })

  const { balance, allowance } = await readTakerPosition({
    taker: request.taker,
    token: plan.tokenIn,
    router: request.router,
  })
  // The page disarms the fill on both of these before a request goes out, so reaching here means the balance
  // moved between the read and the press. The buttons are named as the sidebar labels them, step included.
  if (balance < plan.quotedIn) {
    throw new TakerNotFundedError(
      `the connected wallet holds ${balance} of the input token and this fill needs ${plan.quotedIn}. Press ` +
        'Mint, step 1 in the wallet panel, the token is a TestERC20 whose mint is public.',
      { token: plan.tokenIn, amount: plan.quotedIn, balance, allowance },
    )
  }
  if (allowance < plan.quotedIn) {
    throw new TakerNotFundedError(
      `the router is approved for ${allowance} of the input token and this fill needs ${plan.quotedIn}. Press ` +
        'Approve the router, step 2 in the wallet panel. The allowance goes to the router because it pushes ' +
        'into Aqua on your behalf.',
      { token: plan.tokenIn, amount: plan.quotedIn, balance, allowance },
    )
  }

  const swapArgs = {
    address: request.router,
    abi: routerAbi,
    functionName: 'swap',
    args: [request.order, request.amount, plan.takerTraitsAndData],
    account: request.taker,
  } as const

  // The simulation runs the whole program, both hooks included, against live state. A fill that cannot settle
  // fails here with the VM's own error instead of costing a reverted transaction.
  const { result } = await publicClient.simulateContract(swapArgs)
  const [simulatedIn, simulatedOut, simulatedHash] = result
  emit({ type: 'log', line: `simulated  ${simulatedIn} in, ${simulatedOut} out, orderHash ${simulatedHash}` })

  const base: Omit<FillResult, 'transactionHash' | 'blockNumber' | 'gasUsed' | 'receipt' | 'dry'> = {
    orderHash: plan.orderHash,
    amountIn: simulatedIn,
    amountOut: simulatedOut,
    decreaseCalldata: plan.decreaseCalldata,
    increaseCalldata: plan.increaseCalldata,
    takerTraitsAndData: plan.takerTraitsAndData,
    unwindPercent: plan.unwindPercent,
    taker: request.taker,
    tokenIn: plan.tokenIn,
    tokenOut: plan.tokenOut,
    steps,
    log,
  }

  if (request.dry) {
    return { ...base, transactionHash: null, blockNumber: null, gasUsed: null, receipt: null, dry: true }
  }

  if (!request.wallet) throw new Error('the wallet is not ready, so there is nothing to sign swap() with')

  const transactionHash = await request.wallet.writeContract({
    ...swapArgs,
    account: request.taker,
    chain: CHAIN,
  })
  emit({ type: 'sent', hash: transactionHash })
  emit({ type: 'step', index: 6, label: 'read the receipt back and prove the two PositionManager calls' })
  emit({ type: 'log', line: `transaction  ${transactionHash}` })

  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash })
  if (receipt.status !== 'success') {
    throw new Error('the fill reverted on chain, the receipt panel below decodes what happened')
  }
  emit({ type: 'log', line: `status  success, block ${receipt.blockNumber}, gas ${receipt.gasUsed}` })

  // The amounts in `base` are the simulation's, taken one block before this one, so they are a prediction. The
  // logs are where the settled figures live, and the same read-back also carries the two PositionManager calls
  // and the position's liquidity around each. A read-back that fails does not fail the fill: the swap is on
  // chain either way, and the panel says the decoding is missing instead of reprinting the request.
  const decoded = await readFillReceipt(transactionHash, {
    router: request.router,
    vault: request.vault,
    poolManager: request.poolManager ?? null,
    positionManager: request.positionManager,
    poolId: request.poolId ?? null,
  }).catch((error) => {
    emit({ type: 'log', line: `receipt not decoded  ${reason(error)}` })
    return null
  })

  const settled = decoded?.swapped.ok ? decoded.swapped.value : null
  if (settled) {
    emit({ type: 'log', line: `settled  ${settled.amountIn} in, ${settled.amountOut} out, from the Swapped event` })
  }

  return {
    ...base,
    amountIn: settled ? settled.amountIn : base.amountIn,
    amountOut: settled ? settled.amountOut : base.amountOut,
    transactionHash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    receipt: decoded,
    dry: false,
  }
}
