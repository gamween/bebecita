import type { Address, Hex } from 'viem'

import { planFill, type ChainReader, type FillPlan, type LiquidityApi } from '@solver/fillPlan'
import { erc20Abi, positionManagerAbi, routerAbi, vaultAbi } from './abi'
import { CHAIN, publicClient, walletClientFor } from './client'
import { decrease, increase } from './uniswap'

/**
 * The fill, in the tab, signed by the connected wallet.
 *
 * There is no backend. The taker traits are encoded by `solver/src/takerTraits.ts`, a port of the sponsor's
 * `TakerTraitsLib.build` that `contracts/test/TakerTraits.t.sol` proves byte for byte against the library
 * itself, and the sizing is `solver/src/fillPlan.ts`, the same module `yarn fill` runs. This file is only the
 * browser's half of the environment those two need: reads through viem, the two Uniswap calls through the dev
 * server proxy that holds the API key, and `swap()` through `window.ethereum`.
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
  order: { maker: Address; traits: bigint; data: Hex }
  orderHash?: Hex
  router: Address
  vault: Address
  positionManager: Address
  tokenId: bigint
  token0: Address
  token1: Address
  unitsPerLiquidityE18: bigint
  maxUnwindPct: number
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
  | { type: 'error'; message: string }

export interface FillResult {
  /** Null on a dry run, which simulates against live state and broadcasts nothing. */
  transactionHash: Hex | null
  orderHash: Hex
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
export async function mintTo(params: { token: Address; taker: Address; amount: bigint }): Promise<Hex> {
  const wallet = walletClientFor(params.taker)
  return wallet.writeContract({
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
  token: Address
  taker: Address
  router: Address
  amount?: bigint
}): Promise<Hex> {
  const wallet = walletClientFor(params.taker)
  return wallet.writeContract({
    account: params.taker,
    chain: CHAIN,
    address: params.token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [params.router, params.amount ?? 2n ** 256n - 1n],
  })
}

/**
 * Quote, size, fetch, encode, sign, broadcast. The whole fill, in the tab.
 *
 * The plan is built first and is read only, so nothing is signed until the two Uniswap payloads exist and the
 * taker traits have been encoded. The swap is then simulated against live state, which is what turns a VM
 * revert into a message before a nonce is spent, and only then handed to the wallet.
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
  if (balance < plan.quotedIn) {
    throw new TakerNotFundedError(
      `the connected wallet holds ${balance} of the input token and this fill needs ${plan.quotedIn}. Press ` +
        'Mint test tokens, the token is a TestERC20 whose mint is public.',
      { token: plan.tokenIn, amount: plan.quotedIn, balance, allowance },
    )
  }
  if (allowance < plan.quotedIn) {
    throw new TakerNotFundedError(
      `the router is approved for ${allowance} of the input token and this fill needs ${plan.quotedIn}. Press ` +
        'Approve the router. The allowance goes to the router because it pushes into Aqua on your behalf.',
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

  const base: Omit<FillResult, 'transactionHash' | 'dry'> = {
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

  if (request.dry) return { ...base, transactionHash: null, dry: true }

  const wallet = walletClientFor(request.taker)
  const transactionHash = await wallet.writeContract({ ...swapArgs, chain: CHAIN })
  emit({ type: 'step', index: 6, label: 'read the receipt back and prove the two PositionManager calls' })
  emit({ type: 'log', line: `transaction  ${transactionHash}` })

  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash })
  if (receipt.status !== 'success') {
    throw new Error(`the fill reverted, ${transactionHash}. The receipt panel below decodes what happened.`)
  }
  emit({ type: 'log', line: `status  success, block ${receipt.blockNumber}, gas ${receipt.gasUsed}` })

  return { ...base, transactionHash, dry: false }
}
