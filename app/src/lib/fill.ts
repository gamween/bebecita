import type { Address, Hex } from 'viem'

/**
 * The fill, from the browser.
 *
 * The orchestration lives in `solver/src/fill.ts` and is signed by the key that owns the vault, so it runs in a
 * process and not in a tab. `solver/src/server.ts` puts it behind `POST /fill` and this module is the client.
 *
 * Two things are worth knowing about the transport. The response is newline delimited JSON, one event per line,
 * because a fill takes a quote, two Uniswap API calls, a Foundry simulation and a broadcast, and the steps are
 * worth watching. And the endpoint is `VITE_SOLVER_URL` when the operator set one, otherwise `/api/solver`,
 * which the dev server proxies to the solver, so the default needs no configuration and no CORS.
 *
 * When no solver answers, this throws `FillNotWiredError` and the dashboard says so, naming the URL it tried
 * and the command that starts one. It never pretends a transaction happened.
 */

export interface FillRequest {
  /** Taker amount, in the smallest unit. Input amount when `isExactIn`, output amount otherwise. */
  amount: bigint
  isExactIn: boolean
  /** True means token A in and token B out, matching the `IS_A_TO_B` taker trait. */
  isAToB: boolean
  /** Address that pays the input and receives the output. */
  taker: Address
  /** Simulate against live state and broadcast nothing, the same as `yarn fill --dry`. */
  dry?: boolean
  /** Called as the solver reports progress, so the page can render a step while the next one runs. */
  onEvent?: (event: FillEvent) => void
}

export interface FillStep {
  index: number
  label: string
  at: number
}

export type FillEvent =
  | { type: 'accepted'; command: string; dry: boolean }
  | { type: 'step'; index: number; label: string }
  | { type: 'log'; line: string; stream?: 'stdout' | 'stderr' }
  | { type: 'result'; [key: string]: unknown }
  | { type: 'error'; message: string }

export interface FillResult {
  /** Null on a dry run, which simulates against live state and broadcasts nothing. */
  transactionHash: Hex | null
  orderHash: Hex | null
  amountIn: bigint | null
  amountOut: bigint | null
  /** The two payloads the Uniswap API built for this fill, exactly as placed in the taker traits slices. */
  decreaseCalldata: Hex
  increaseCalldata: Hex
  /** What the API was asked to unwind, rounded up, in percent. */
  unwindPercent: number
  /** The address the solver actually sent from, which is its own key and not the connected wallet. */
  taker: Address | null
  tokenIn: Address | null
  tokenOut: Address | null
  gasUsed: bigint | null
  blockNumber: bigint | null
  dry: boolean
  command: string | null
  steps: FillStep[]
  log: string[]
}

export type RunFill = (request: FillRequest) => Promise<FillResult>

export class FillNotWiredError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'FillNotWiredError'
  }
}

/** Same origin by default, proxied to the solver by the dev server. `VITE_SOLVER_URL` overrides it. */
const DEFAULT_SOLVER_URL = '/api/solver'
const CONFIGURED: string | undefined = import.meta.env.VITE_SOLVER_URL

export const solverUrl = (): string => (CONFIGURED || DEFAULT_SOLVER_URL).replace(/\/$/, '')

export interface SolverHealth {
  ok: true
  url: string
  chainId?: number
  vault?: Address
  router?: Address
  tokenId?: string | null
  strategyHash?: Hex | null
  busy?: boolean
  lastFill?: { txHash?: Hex; blockNumber?: string } | null
  /** True when the URL came from `VITE_SOLVER_URL` rather than from the proxied default. */
  configured: boolean
}

export type SolverProbe = SolverHealth | { ok: false; url: string; reason: string; configured: boolean }

/** Asks the solver whether it is there. Cheap, local, and the only honest way to know before pressing a button. */
export async function probeSolver(): Promise<SolverProbe> {
  const url = solverUrl()
  const configured = Boolean(CONFIGURED)
  try {
    const response = await fetch(`${url}/health`, { headers: { Accept: 'application/json' }, cache: 'no-store' })
    if (!response.ok) {
      return { ok: false, url, configured, reason: `the solver answered ${response.status} on /health` }
    }
    const payload = (await response.json()) as Record<string, unknown>
    return { ...(payload as object), ok: true, url, configured } as SolverHealth
  } catch (error) {
    return { ok: false, url, configured, reason: (error as Error).message }
  }
}

export function fillWiring(probe?: SolverProbe | null): { wired: boolean; detail: string } {
  const url = solverUrl()
  const where = CONFIGURED ? `VITE_SOLVER_URL, ${url}` : `${url}, proxied to the solver by the dev server`
  if (!probe) return { wired: false, detail: `looking for a solver at ${where}` }
  if (probe.ok) return { wired: true, detail: `posting fills to ${where}` }
  return {
    wired: false,
    detail:
      `no solver is answering at ${where}: ${probe.reason}. It holds the key that signs the swap, which is why ` +
      'the fill cannot run in this tab. Start it with yarn solver:serve at the repository root.',
  }
}

const asBigInt = (value: unknown): bigint | null => {
  if (value === null || value === undefined || value === '') return null
  try {
    return BigInt(value as string)
  } catch {
    return null
  }
}

function resultFrom(
  event: Record<string, unknown>,
  context: { steps: FillStep[]; log: string[]; command: string | null },
): FillResult {
  return {
    transactionHash: (event.transactionHash as Hex) ?? null,
    orderHash: (event.orderHash as Hex) ?? null,
    amountIn: asBigInt(event.amountIn),
    amountOut: asBigInt(event.amountOut),
    decreaseCalldata: (event.decreaseCalldata as Hex) ?? '0x',
    increaseCalldata: (event.increaseCalldata as Hex) ?? '0x',
    unwindPercent: Number(event.unwindPercent ?? 0),
    taker: (event.taker as Address) ?? null,
    tokenIn: (event.tokenIn as Address) ?? null,
    tokenOut: (event.tokenOut as Address) ?? null,
    gasUsed: asBigInt(event.gasUsed),
    blockNumber: asBigInt(event.blockNumber),
    dry: event.dry === true,
    command: context.command,
    steps: context.steps,
    log: context.log,
  }
}

/**
 * Posts the fill and consumes the event stream.
 *
 * A solver that answers `application/json` instead, which is what it does when asked for it, still works: the
 * body is then one result object and the loop below simply sees a single line.
 */
async function postFillToSolver(base: string, request: FillRequest): Promise<FillResult> {
  let response: Response
  try {
    response = await fetch(`${base}/fill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({
        amount: request.amount.toString(),
        isExactIn: request.isExactIn,
        isAToB: request.isAToB,
        taker: request.taker,
        dry: request.dry === true,
      }),
    })
  } catch (error) {
    throw new FillNotWiredError(
      `no solver answered at ${base}: ${(error as Error).message}. Start it with yarn solver:serve at the ` +
        'repository root, it holds the key that signs the swap.',
    )
  }

  const steps: FillStep[] = []
  const log: string[] = []
  let command: string | null = null
  let result: FillResult | null = null
  let failure: string | null = null

  const handle = (event: FillEvent) => {
    request.onEvent?.(event)
    if (event.type === 'accepted') command = event.command
    if (event.type === 'step') steps.push({ index: event.index, label: event.label, at: Date.now() })
    if (event.type === 'log') log.push(event.line)
    if (event.type === 'error') failure = event.message
    if (event.type === 'result') result = resultFrom(event as unknown as Record<string, unknown>, { steps, log, command })
  }

  const consume = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      handle(JSON.parse(trimmed) as FillEvent)
    } catch {
      log.push(trimmed)
    }
  }

  if (!response.body) {
    // No streaming body available. The payload is then a single JSON document, error or result alike.
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(messageOf(payload) ?? `the solver returned ${response.status}`)
    handle(payload as FillEvent)
  } else {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) consume(line)
    }
    consume(buffer)
  }

  if (failure) throw new Error(failure)
  if (!response.ok && !result) throw new Error(`the solver returned ${response.status}`)
  if (!result) throw new Error('the solver closed the stream without a result')
  return result
}

function messageOf(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'message' in payload) return String((payload as { message: unknown }).message)
  return null
}

export const runFill: RunFill = async (request) => postFillToSolver(solverUrl(), request)
