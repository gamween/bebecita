/**
 * Uniswap LP API client.
 *
 * The API is the funding mechanism of this project, not a price feed. Every fill on the Aqua book is funded
 * by a `/lp/decrease` call and refunded by `/lp/increase`, and the calldata these return is executed on-chain
 * inside the same transaction as the fill.
 *
 * Host note, and it is the detail that costs an afternoon: the seven `/lp/*` operations live in the same
 * OpenAPI document as `trade-api.gateway.uniswap.org/v1` and use the same `x-api-key` security scheme, but the
 * document carries a per-path server override and they are served from `https://liquidity.api.uniswap.org`
 * with no version prefix. Grepping request logs for `trade-api` will therefore find nothing.
 */

const LP_HOST = 'https://liquidity.api.uniswap.org'
const TRADE_HOST = 'https://trade-api.gateway.uniswap.org/v1'

export type Protocol = 'V2' | 'V3' | 'V4'

export interface UniswapConfig {
  apiKey: string
  chainId: number
  protocol: Protocol
}

export interface TransactionRequest {
  to: string
  data: string
  value?: string
  from?: string
  gasLimit?: string
}

/** Thrown with the body attached, because the gateway explains itself in the payload rather than the status. */
export class UniswapApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${path} returned ${status}: ${JSON.stringify(body)}`)
  }
}

export class UniswapClient {
  private rateLimitRemaining: string | null = null

  constructor(private readonly config: UniswapConfig) {
    if (!config.apiKey) throw new Error('UNISWAP_API_KEY is required')
  }

  /** Last value of the `x-ratelimit-remaining` header, surfaced so the demo panel can prove the key is real. */
  get remainingQuota(): string | null {
    return this.rateLimitRemaining
  }

  private async post<T>(host: string, path: string, body: unknown): Promise<T> {
    const response = await fetch(`${host}${path}`, {
      method: 'POST',
      headers: {
        'x-api-key': this.config.apiKey,
        // The header validator is strict: these two must contain nothing but the media type.
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })

    this.rateLimitRemaining = response.headers.get('x-ratelimit-remaining')

    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new UniswapApiError(path, response.status, payload)
    return payload as T
  }

  /** Pool state and current tick. Used to size a clip and to mirror the position range into the Aqua program. */
  async poolInfo(params: {
    tokenA: string
    tokenB: string
    fee: number
    tickSpacing: number
    hooks?: string
  }): Promise<any> {
    return this.post(LP_HOST, '/lp/pool_info', {
      chainId: this.config.chainId,
      protocol: this.config.protocol,
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
   * Approvals for liquidity operations.
   *
   * `generatePermitAsTransaction: true` is the flag that makes this project possible at all. The spec describes
   * it as "permits are returned as on-chain transactions rather than off-chain signatures", which is what lets
   * a contract own the position: the vault cannot sign EIP-712, it can only execute.
   */
  async checkApproval(params: {
    walletAddress: string
    token0: string
    token1: string
    amount0: string
    amount1: string
    tokenId?: number
  }): Promise<any> {
    return this.post(LP_HOST, '/lp/check_approval', {
      walletAddress: params.walletAddress,
      chainId: this.config.chainId,
      protocol: this.config.protocol,
      action: 'INCREASE',
      generatePermitAsTransaction: true,
      simulateTransaction: false,
      lpTokens: [
        { address: params.token0, amount: params.amount0 },
        { address: params.token1, amount: params.amount1 },
      ],
      ...(params.tokenId !== undefined ? { v3NftTokenId: params.tokenId } : {}),
    })
  }

  /**
   * Open the position.
   *
   * `newPool` is what removes every dependency on pre-existing testnet liquidity: we deploy both ERC20s, mint
   * them to ourselves, and have the API create the pool and the position in one call. The demo therefore owns
   * its own pool, which is what makes it deterministic and replayable.
   */
  async createPosition(params: {
    walletAddress: string
    token0: string
    token1: string
    fee: number
    tickSpacing: number
    tickLower: number
    tickUpper: number
    independentToken: 'TOKEN_0' | 'TOKEN_1'
    independentAmount: string
    initialPrice?: string
  }): Promise<any> {
    return this.post(LP_HOST, '/lp/create', {
      walletAddress: params.walletAddress,
      chainId: this.config.chainId,
      protocol: this.config.protocol,
      newPool: {
        token0: params.token0,
        token1: params.token1,
        fee: params.fee,
        tickSpacing: params.tickSpacing,
        hooks: '0x0000000000000000000000000000000000000000',
        ...(params.initialPrice ? { initialPrice: params.initialPrice } : {}),
      },
      tickBounds: { tickLower: params.tickLower, tickUpper: params.tickUpper },
      independentToken: params.independentToken,
      independentAmount: params.independentAmount,
      slippageTolerance: 5,
      simulateTransaction: false,
    })
  }

  /**
   * The unwind. Called once per fill, and its calldata goes verbatim into the `preTransferOutHookData` slice
   * of the taker traits.
   *
   * `liquidityPercentageToDecrease` is an integer in [1, 100]. A just-in-time withdrawal can therefore never
   * be exact: we round up and keep the surplus as float. That constraint is reported in FEEDBACK.md.
   */
  async decrease(params: {
    walletAddress: string
    tokenId: number
    token0: string
    token1: string
    percent: number
  }): Promise<{ decrease: TransactionRequest; [k: string]: unknown }> {
    const percent = Math.min(100, Math.max(1, Math.ceil(params.percent)))
    return this.post(LP_HOST, '/lp/decrease', {
      walletAddress: params.walletAddress,
      chainId: this.config.chainId,
      protocol: this.config.protocol,
      nftTokenId: params.tokenId,
      token0Address: params.token0,
      token1Address: params.token1,
      liquidityPercentageToDecrease: percent,
      slippageTolerance: 5,
      simulateTransaction: false,
      withdrawAsWeth: false,
    })
  }

  /** The refund. Its calldata goes into the `postTransferInHookData` slice. */
  async increase(params: {
    walletAddress: string
    tokenId: number
    token0: string
    token1: string
    amount0: string
    amount1: string
  }): Promise<{ increase: TransactionRequest; [k: string]: unknown }> {
    return this.post(LP_HOST, '/lp/increase', {
      walletAddress: params.walletAddress,
      chainId: this.config.chainId,
      protocol: this.config.protocol,
      nftTokenId: params.tokenId,
      token0: { address: params.token0, amount: params.amount0 },
      token1: { address: params.token1, amount: params.amount1 },
      slippageTolerance: 5,
      simulateTransaction: false,
    })
  }

  /** Fees the same capital earned while it was quoting. Closing panel of the demo. */
  async claimFees(params: { walletAddress: string; tokenId: number; token0: string; token1: string }): Promise<any> {
    return this.post(LP_HOST, '/lp/claim_fees', {
      walletAddress: params.walletAddress,
      chainId: this.config.chainId,
      protocol: this.config.protocol,
      nftTokenId: params.tokenId,
      token0Address: params.token0,
      token1Address: params.token1,
      simulateTransaction: false,
    })
  }

  /** Reachability probe against the trade host, used by the gate zero check. */
  async supportedChains(): Promise<any> {
    const response = await fetch(`${TRADE_HOST}/supported_chains`, {
      headers: { 'x-api-key': this.config.apiKey, Accept: 'application/json' },
    })
    this.rateLimitRemaining = response.headers.get('x-ratelimit-remaining')
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new UniswapApiError('/supported_chains', response.status, payload)
    return payload
  }
}
