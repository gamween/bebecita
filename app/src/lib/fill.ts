import type { Address, Hex } from 'viem'

/**
 * The fill, and the one thing in this app that is not live yet.
 *
 * The orchestration lives in `solver/src/fill.ts` (task T3): read the quote through `asView()`, size the
 * unwind, round the percentage up because `/lp/decrease` only takes integers, call `/lp/decrease` and
 * `/lp/increase`, place the two calldatas into the `preTransferOutHookData` and `postTransferInHookData`
 * slices of the taker traits, and send the swap. It signs with the deployer key, so it runs in a process and
 * not in a browser tab: this module is the seam between the two.
 *
 * The signature below is the one the solver exposes. Wiring it is configuration, not code: point
 * `VITE_SOLVER_URL` at the solver's HTTP entry point and `runFill` starts posting real fills. Until then it
 * refuses, loudly, rather than pretending a transaction happened.
 */

export interface FillRequest {
  /** Taker amount, in the smallest unit. Input amount when `isExactIn`, output amount otherwise. */
  amount: bigint
  isExactIn: boolean
  /** True means token A in and token B out, matching the `IS_A_TO_B` taker trait. */
  isAToB: boolean
  /** Address that pays the input and receives the output. */
  taker: Address
}

export interface FillResult {
  transactionHash: Hex
  orderHash: Hex
  amountIn: bigint
  amountOut: bigint
  /** The two payloads the Uniswap API built for this fill, exactly as placed in the taker traits slices. */
  decreaseCalldata: Hex
  increaseCalldata: Hex
  /** What the API was asked to unwind, rounded up, in percent. */
  unwindPercent: number
}

export type RunFill = (request: FillRequest) => Promise<FillResult>

export class FillNotWiredError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'FillNotWiredError'
  }
}

const SOLVER_URL: string | undefined = import.meta.env.VITE_SOLVER_URL

export function fillWiring(): { wired: boolean; detail: string } {
  if (SOLVER_URL) {
    return { wired: true, detail: `posting fills to ${SOLVER_URL}` }
  }
  return {
    wired: false,
    detail:
      'the fill orchestrator is not merged yet. This button posts to the solver, which holds the key that signs the swap, so it stays inert until VITE_SOLVER_URL points at it.',
  }
}

/** Real transport. The solver answers with the fill result, including both API payloads it executed. */
async function postFillToSolver(base: string, request: FillRequest): Promise<FillResult> {
  const response = await fetch(`${base.replace(/\/$/, '')}/fill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      amount: request.amount.toString(),
      isExactIn: request.isExactIn,
      isAToB: request.isAToB,
      taker: request.taker,
    }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`the solver returned ${response.status}: ${JSON.stringify(payload)}`)

  const result = payload as Record<string, string | number>
  return {
    transactionHash: result.transactionHash as Hex,
    orderHash: result.orderHash as Hex,
    amountIn: BigInt(result.amountIn),
    amountOut: BigInt(result.amountOut),
    decreaseCalldata: result.decreaseCalldata as Hex,
    increaseCalldata: result.increaseCalldata as Hex,
    unwindPercent: Number(result.unwindPercent),
  }
}

export const runFill: RunFill = async (request) => {
  const wiring = fillWiring()
  if (!wiring.wired || !SOLVER_URL) throw new FillNotWiredError(wiring.detail)
  return postFillToSolver(SOLVER_URL, request)
}
