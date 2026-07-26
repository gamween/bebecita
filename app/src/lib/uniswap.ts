import { LP_SIMULATE_TRANSACTION, LP_SLIPPAGE_TOLERANCE_PCT } from '@solver/lpParams'
import { netlog } from './netlog'

/**
 * Browser side Uniswap LP API client.
 *
 * Same host trap as `solver/src/uniswap.ts`: the `/lp/*` operations share an OpenAPI document with
 * `trade-api.gateway.uniswap.org/v1` but are served from `https://liquidity.api.uniswap.org` with no version
 * prefix. Requests leave through the proxy at `/api/uniswap`, which attaches `x-api-key` server side, so the
 * key is never part of the bundle. The proxy also echoes the upstream URL back in `x-bebecita-upstream`, which
 * is what lets the network panel show where the request actually went.
 *
 * This file is the transport, and only the transport. Everything that shapes a request body is in
 * `solver/src/lpParams.ts`, shared with the terminal client, so the payload this tab previews is the payload
 * `yarn fill` would place in the taker traits. The request bodies below are otherwise field for field what
 * `solver/src/uniswap.ts` sends, and the OpenAPI document at
 * `https://trade-api.gateway.uniswap.org/v1/api.json` is the arbiter of which fields exist at all.
 */

export const LP_HOST = 'https://liquidity.api.uniswap.org'
const PROXY_BASE = '/api/uniswap'

export type Protocol = 'V2' | 'V3' | 'V4'

export interface TransactionRequest {
  to: string
  data: string
  value?: string
  from?: string
  gasLimit?: string
}

export class UniswapApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${path} returned ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
  }
}

export interface ApiCall<T> {
  payload: T
  status: number
  rateLimitRemaining: string | null
  upstream: string | null
}

async function post<T>(label: string, path: string, body: unknown): Promise<ApiCall<T>> {
  const url = `${PROXY_BASE}${path}`
  const id = netlog.start(label, 'POST', url, body)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    const message = `${(error as Error).message}. The Uniswap calls go through the dev server proxy, which is what holds the API key, so they need \`yarn dev\` or \`yarn preview\` rather than a plain static server.`
    netlog.finish(id, { error: message })
    throw new Error(message)
  }

  const rateLimitRemaining = response.headers.get('x-ratelimit-remaining')
  const upstream = response.headers.get('x-bebecita-upstream')
  const apiKeyAttached = response.headers.get('x-bebecita-api-key')
  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })

  const text = await response.text()
  let payload: unknown = text
  try {
    payload = JSON.parse(text)
  } catch {
    /* left as text, which is itself the diagnosis when a static server answered with HTML */
  }

  netlog.finish(id, {
    status: response.status,
    response: payload,
    rateLimitRemaining,
    upstream,
    apiKeyAttached: apiKeyAttached === null ? null : apiKeyAttached === 'present',
    responseHeaders,
    error: response.ok ? null : `HTTP ${response.status}`,
  })

  if (!response.ok) throw new UniswapApiError(path, response.status, payload)
  return { payload: payload as T, status: response.status, rateLimitRemaining, upstream }
}

export interface PoolParams {
  chainId: number
  protocol?: Protocol
  tokenA: string
  tokenB: string
  fee: number
  tickSpacing: number
  hooks?: string
}

/** Pool state and current tick. Same call the solver uses to size a clip. */
export function poolInfo(params: PoolParams) {
  return post<Record<string, unknown>>('POST /lp/pool_info', '/lp/pool_info', {
    chainId: params.chainId,
    protocol: params.protocol ?? 'V4',
    poolParameters: {
      tokenAddressA: params.tokenA,
      tokenAddressB: params.tokenB,
      fee: params.fee,
      tickSpacing: params.tickSpacing,
      hookAddress: params.hooks ?? '0x0000000000000000000000000000000000000000',
    },
  })
}

/**
 * The unwind. Its calldata is what goes verbatim into the `preTransferOutHookData` slice of the taker traits
 * and is executed by `BebecitaVault.preTransferOut` one instruction before the tokens leave the maker.
 * `liquidityPercentageToDecrease` is an integer in [1, 100], which is why a just in time withdrawal always
 * rounds up and leaves the surplus as float.
 */
export function decrease(params: {
  chainId: number
  protocol?: Protocol
  walletAddress: string
  tokenId: string
  token0: string
  token1: string
  percent: number
  slippageTolerance?: number
}) {
  const percent = Math.min(100, Math.max(1, Math.ceil(params.percent)))
  return post<Record<string, unknown>>('POST /lp/decrease', '/lp/decrease', {
    walletAddress: params.walletAddress,
    chainId: params.chainId,
    protocol: params.protocol ?? 'V4',
    // A string, not a number. `nftTokenId: 1` is rejected with "cannot decode field
    // uniswap.liquidity.v2.DecreasePositionRequest.nft_token_id from JSON: 1", verified against the live API.
    nftTokenId: params.tokenId,
    token0Address: params.token0,
    token1Address: params.token1,
    liquidityPercentageToDecrease: percent,
    // The same tolerance the command line fill uses, from the same constant, so the payload this button
    // previews is the payload a fill would actually place in the taker traits.
    slippageTolerance: params.slippageTolerance ?? LP_SLIPPAGE_TOLERANCE_PCT,
    simulateTransaction: LP_SIMULATE_TRANSACTION,
    // `withdrawAsWeth` is in the schema and used to be sent as false here and omitted by the terminal client.
    // It only decides whether a native leg comes back wrapped, and the demo pair is two plain ERC20s, so the
    // field could never do anything. Omitted on both sides rather than sent on one.
  })
}

/**
 * The redeposit. Its calldata goes into the `postTransferInHookData` slice and is executed by
 * `BebecitaVault.postTransferIn`, after the taker has been paid and after the taker's input has landed, which
 * is the whole reason `isFirstTransferFromTaker` stays false.
 *
 * One side only: `independentToken` names the token and the amount, and the API computes the other leg from
 * live pool state. There is no two sided form of this request.
 */
export function increase(params: {
  chainId: number
  protocol?: Protocol
  walletAddress: string
  tokenId: string
  token0: string
  token1: string
  independentToken: string
  independentAmount: string
}) {
  return post<Record<string, unknown>>('POST /lp/increase', '/lp/increase', {
    walletAddress: params.walletAddress,
    chainId: params.chainId,
    protocol: params.protocol ?? 'V4',
    nftTokenId: params.tokenId,
    token0Address: params.token0,
    token1Address: params.token1,
    independentToken: { tokenAddress: params.independentToken, amount: params.independentAmount },
    slippageTolerance: LP_SLIPPAGE_TOLERANCE_PCT,
    simulateTransaction: LP_SIMULATE_TRANSACTION,
  })
}

/**
 * The fees the same capital earned while it was quoting.
 *
 * This endpoint names the position `tokenId`, where `/lp/decrease` and `/lp/increase` name it `nftTokenId`.
 * Sending `nftTokenId` here fails with `ClaimFeesRequest validation error: "tokenId" is not allowed to be
 * empty`. Established against the live gateway, and one for FEEDBACK.md.
 *
 * It also takes no token addresses at all. `ClaimFeesRequest` in the live OpenAPI document declares exactly
 * `protocol`, `walletAddress`, `chainId`, `tokenId`, `simulateTransaction` and `collectAsWeth`, and the
 * gateway happens to ignore anything else rather than rejecting it, which is how `token0Address` and
 * `token1Address` sat in this body being silently discarded while the terminal client correctly omitted them.
 * Sending a field the schema does not declare is a claim about the API that is not true.
 */
export function claimFees(params: {
  chainId: number
  protocol?: Protocol
  walletAddress: string
  tokenId: string
}) {
  return post<Record<string, unknown>>('POST /lp/claim_fees', '/lp/claim_fees', {
    walletAddress: params.walletAddress,
    chainId: params.chainId,
    protocol: params.protocol ?? 'V4',
    tokenId: params.tokenId,
    simulateTransaction: LP_SIMULATE_TRANSACTION,
  })
}

/**
 * Pulls the first transaction request out of a response without assuming which key holds it. The LP endpoints
 * nest it under different names per operation, and guessing wrong is worse than searching.
 */
export function findTransactionRequest(payload: unknown): TransactionRequest | null {
  const seen = new Set<unknown>()
  const walk = (node: unknown): TransactionRequest | null => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null
    seen.add(node)
    const record = node as Record<string, unknown>
    if (typeof record.to === 'string' && typeof record.data === 'string' && record.data.startsWith('0x')) {
      return record as unknown as TransactionRequest
    }
    for (const value of Object.values(record)) {
      const found = walk(value)
      if (found) return found
    }
    return null
  }
  return walk(payload)
}
