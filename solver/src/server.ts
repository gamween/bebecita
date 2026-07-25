/**
 * The fill, exposed over HTTP, so the dashboard button runs the real thing.
 *
 * Run with `yarn solver:serve`. It listens on 127.0.0.1:8787 by default and exposes two routes:
 *
 *   GET  /health   what the solver is pointed at, and the last fill it recorded
 *   POST /fill     one fill, streamed back as newline delimited JSON
 *
 * The fill has to be signed by the key that owns the vault, so it cannot run in a browser tab. This process is
 * the seam. It does not reimplement the orchestration: it spawns `solver/src/fill.ts`, which is exactly what
 * `yarn fill` runs, and relays that process line by line. There is therefore no second code path to keep in
 * sync with the first, and no way for the button to send a transaction the command line would not have sent.
 *
 * The response is `application/x-ndjson` rather than one JSON object, because a fill takes a quote, two Uniswap
 * API calls, a Foundry simulation and a broadcast, and a demo that shows a spinner for forty seconds is a demo
 * that looks broken. Every line is one event:
 *
 *   {"type":"accepted", ...}                 the command that is about to run
 *   {"type":"step","index":1,"label":"..."}  the numbered steps the fill script prints
 *   {"type":"log","line":"..."}              everything else it prints, verbatim
 *   {"type":"result", ...}                   the transaction, read back out of the deployment record
 *   {"type":"error","message":"..."}         the run failed, with the reason
 *
 * A client that wants one object instead can send `Accept: application/json` and gets the result event alone.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'

import { formatUnits, getAddress, type Hex } from 'viem'

import { SEPOLIA } from './config.js'
import { FILL_REQUEST_PATH, FILL_REQUEST_RELATIVE, readDeployments } from './strategy.js'

const ROOT = resolve(import.meta.dirname, '../..')
const FILL_SCRIPT = 'solver/src/fill.ts'
const TSX = resolve(ROOT, 'node_modules/.bin/tsx')

const PORT = Number(process.env.SOLVER_PORT ?? 8787)
const HOST = process.env.SOLVER_HOST ?? '127.0.0.1'

/** One fill at a time. Two concurrent runs would race on the same nonce and on the handover file. */
let running = false

interface FillBody {
  /** Input amount in the smallest unit, as a decimal string. The fill script takes whole tokens. */
  amount?: string | number
  isExactIn?: boolean
  isAToB?: boolean
  taker?: string
  /** Simulate against live state and broadcast nothing. Same flag as `yarn fill --dry`. */
  dry?: boolean
}

interface LastFill {
  txHash?: string
  orderHash?: string
  amountIn?: string
  amountOut?: string
  tokenIn?: string
  tokenOut?: string
  unwindPercent?: number
  gasUsed?: string
  blockNumber?: string
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<FillBody> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw) as FillBody
}

/** The record the fill script writes when it has read the receipt back. */
function lastFillOf(): LastFill | null {
  try {
    return ((readDeployments() as { lastFill?: LastFill }).lastFill ?? null) as LastFill | null
  } catch {
    return null
  }
}

/** The handover file, which carries the two Uniswap payloads exactly as they went into the taker traits. */
function fillRequest(): Record<string, unknown> | null {
  if (!existsSync(FILL_REQUEST_PATH)) return null
  try {
    return JSON.parse(readFileSync(FILL_REQUEST_PATH, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * `--amount=` is whole tokens of the input side, the browser sends the smallest unit, and both demo tokens
 * carry 18 decimals. `formatUnits` is the exact inverse of the parser in `fill.ts`, which is why the conversion
 * is done here rather than by hand.
 */
function amountArgument(amount: string | number | undefined): string {
  if (amount === undefined || amount === null || amount === '') {
    throw new Error('amount is required, in the smallest unit of the input token')
  }
  const raw = BigInt(amount)
  if (raw <= 0n) throw new Error(`amount must be positive, got ${raw}`)
  return formatUnits(raw, 18)
}

function validate(body: FillBody): { amountArg: string; dry: boolean } {
  // The order the book quotes is directional: `isAToB` reads the order's two tokens in the sorted order they
  // are stored in, and the shipped balances are asymmetric on purpose, so the reverse direction quotes a price
  // nobody would take. `fill.ts` fills token0 to token1, and saying so is better than silently doing it.
  if (body.isAToB === false) {
    throw new Error(
      'the fill runs token0 to token1, which is the direction the strategy was shipped for. The reverse ' +
        'direction quotes against the generous side of the curve and is not part of this demo.',
    )
  }
  if (body.isExactIn === false) {
    throw new Error('the fill is exact in. An exact out fill would size the unwind from a different quote.')
  }
  return { amountArg: amountArgument(body.amount), dry: body.dry === true }
}

interface Stream {
  send: (event: Record<string, unknown>) => void
  end: () => void
}

/** Newline delimited JSON, flushed per event, so the browser can render a step while the next one runs. */
function ndjson(res: ServerResponse): Stream {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    ...CORS,
  })
  return {
    send: (event) => {
      res.write(`${JSON.stringify(event)}\n`)
    },
    end: () => res.end(),
  }
}

/** Buffers a single object instead, for a client that asked for `application/json`. */
function single(res: ServerResponse): Stream {
  let result: Record<string, unknown> | null = null
  let failure: Record<string, unknown> | null = null
  return {
    send: (event) => {
      if (event.type === 'result') result = event
      if (event.type === 'error') failure = event
    },
    end: () => {
      if (failure) json(res, 500, failure)
      else if (result) json(res, 200, result)
      else json(res, 500, { type: 'error', message: 'the fill produced no result event' })
    },
  }
}

const STEP = /^\[(\d+)\]\s+(.*)$/
/** Raw figures the Foundry script echoes, which is the only place a dry run states what it would have paid. */
const RAW_AMOUNT_OUT = /^amountOut\s+(\d+)$/
const RAW_ORDER_HASH = /^orderHash\s+(0x[0-9a-fA-F]{64})$/

async function runFill(stream: Stream, options: { amountArg: string; dry: boolean }): Promise<void> {
  if (!existsSync(TSX)) {
    stream.send({
      type: 'error',
      message: `tsx is not installed at ${TSX}. Run yarn install at the repository root, which is what \`yarn fill\` needs too.`,
    })
    return
  }

  const before = lastFillOf()
  const args = [FILL_SCRIPT, `--amount=${options.amountArg}`]
  if (options.dry) args.push('--dry')

  stream.send({
    type: 'accepted',
    command: `yarn fill --amount=${options.amountArg}${options.dry ? ' --dry' : ''}`,
    dry: options.dry,
    cwd: ROOT,
    startedAt: Date.now(),
  })

  const child = spawn(TSX, args, { cwd: ROOT, env: process.env })

  const quoted: { amountOut?: string; orderHash?: string } = {}
  const relay = (chunk: string, stderr: boolean) => {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const step = STEP.exec(trimmed)
      if (step) {
        stream.send({ type: 'step', index: Number(step[1]), label: step[2] })
        continue
      }
      quoted.amountOut = RAW_AMOUNT_OUT.exec(trimmed)?.[1] ?? quoted.amountOut
      quoted.orderHash = RAW_ORDER_HASH.exec(trimmed)?.[1] ?? quoted.orderHash
      stream.send({ type: 'log', line: trimmed, stream: stderr ? 'stderr' : 'stdout' })
    }
  }

  let stderrText = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => relay(chunk, false))
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk
    relay(chunk, true)
  })

  const code = await new Promise<number>((done) => {
    child.on('error', (error) => {
      stream.send({ type: 'error', message: `${FILL_SCRIPT} could not be started: ${error.message}` })
      done(-1)
    })
    child.on('close', (status) => done(status ?? -1))
  })
  if (code === -1) return

  if (code !== 0) {
    // The fill script prints its own diagnosis on the last line of stderr, and that sentence is worth more
    // than an exit status, so it is what travels back to the browser.
    const reason = stderrText.trim().split('\n').filter(Boolean).at(-1)
    stream.send({
      type: 'error',
      message: reason ? `the fill failed: ${reason}` : `${FILL_SCRIPT} exited with status ${code}`,
      exitCode: code,
    })
    return
  }

  const request = fillRequest()
  if (!request) {
    stream.send({ type: 'error', message: `the run wrote no ${FILL_REQUEST_RELATIVE}, so there is nothing to report` })
    return
  }

  if (options.dry) {
    stream.send({
      type: 'result',
      dry: true,
      transactionHash: null,
      orderHash: quoted.orderHash ?? null,
      amountIn: String(request.amount ?? ''),
      amountOut: quoted.amountOut ?? null,
      decreaseCalldata: request.decreaseCalldata as Hex,
      increaseCalldata: request.increaseCalldata as Hex,
      unwindPercent: Number(request.unwindPercent ?? 0),
      taker: request.taker as string,
      tokenIn: request.tokenIn as string,
      tokenOut: request.tokenOut as string,
    })
    return
  }

  const after = lastFillOf()
  if (!after?.txHash || after.txHash === before?.txHash) {
    stream.send({
      type: 'error',
      message:
        'the fill script finished without recording a new transaction in deployments/sepolia.json, so there ' +
        'is no hash to show. Read the log above.',
    })
    return
  }

  stream.send({
    type: 'result',
    dry: false,
    transactionHash: after.txHash,
    orderHash: after.orderHash,
    amountIn: after.amountIn,
    amountOut: after.amountOut,
    decreaseCalldata: request.decreaseCalldata as Hex,
    increaseCalldata: request.increaseCalldata as Hex,
    unwindPercent: Number(after.unwindPercent ?? request.unwindPercent ?? 0),
    taker: request.taker as string,
    tokenIn: after.tokenIn ?? (request.tokenIn as string),
    tokenOut: after.tokenOut ?? (request.tokenOut as string),
    gasUsed: after.gasUsed,
    blockNumber: after.blockNumber,
    explorer: `https://sepolia.etherscan.io/tx/${after.txHash}`,
  })
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`)
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    let deployments: Record<string, unknown> = {}
    try {
      deployments = readDeployments() as unknown as Record<string, unknown>
    } catch (error) {
      json(res, 500, { ok: false, error: `deployments/sepolia.json could not be read: ${(error as Error).message}` })
      return
    }
    json(res, 200, {
      ok: true,
      chainId: SEPOLIA.chainId,
      command: `yarn fill`,
      vault: deployments.vault,
      router: deployments.router,
      tokenId: (deployments.position as { tokenId?: string } | undefined)?.tokenId ?? null,
      strategyHash: (deployments.strategy as { orderHash?: string } | undefined)?.orderHash ?? null,
      lastFill: lastFillOf(),
      busy: running,
    })
    return
  }

  if (req.method === 'POST' && path === '/fill') {
    if (running) {
      json(res, 409, {
        type: 'error',
        message: 'a fill is already running. They share a nonce and a handover file, so they run one at a time.',
      })
      return
    }

    void (async () => {
      let stream: Stream | null = null
      running = true
      try {
        const body = await readBody(req)
        const options = validate(body)
        if (body.taker) {
          // The solver signs with the deployer key, so the connected wallet is not the taker. Reporting the
          // address the fill will actually be sent from is the only honest answer to a request that names one.
          getAddress(body.taker)
        }
        const wantsJson = (req.headers.accept ?? '').includes('application/json')
        stream = wantsJson ? single(res) : ndjson(res)
        if (body.taker) {
          stream.send({
            type: 'log',
            line: `requested taker ${getAddress(body.taker)}, the fill is signed by the solver key and sent from it`,
          })
        }
        await runFill(stream, options)
        stream.end()
      } catch (error) {
        const message = (error as Error).message
        if (stream) {
          stream.send({ type: 'error', message })
          stream.end()
        } else {
          json(res, 400, { type: 'error', message })
        }
      } finally {
        running = false
      }
    })()
    return
  }

  json(res, 404, { type: 'error', message: `no route for ${req.method} ${path}. This server exposes GET /health and POST /fill.` })
})

server.listen(PORT, HOST, () => {
  console.log(`\nBebecita solver, Ethereum Sepolia`)
  console.log(`    listening       http://${HOST}:${PORT}`)
  console.log(`    POST /fill      runs ${FILL_SCRIPT}, the same code path as yarn fill`)
  console.log(`    GET  /health    what this process is pointed at`)
  console.log(`\nPoint the dashboard at it with VITE_SOLVER_URL, or leave it and the app proxies /api/solver.\n`)
})
