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
  chainId?: number
  gasLimit?: string
}

/** `/lp/check_approval` wraps every transaction it returns, permits included, in this envelope. */
export interface ApprovalTransaction {
  transaction: TransactionRequest
  cancelApproval?: boolean
  action?: string
}

export interface CheckApprovalResponse {
  requestId: string
  transactions: ApprovalTransaction[]
  kycRequiredWarnings?: unknown[]
}

export interface LpToken {
  tokenAddress: string
  amount: string
}

export interface CreatePositionResponse {
  requestId: string
  token0: LpToken
  token1: LpToken
  tickLower: number
  tickUpper: number
  adjustedMinPrice: string
  adjustedMaxPrice: string
  create: TransactionRequest
  gasFee?: string
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
   *
   * The list comes back ordered and must be executed in order: per token, an ERC20 `approve` to Permit2, then a
   * Permit2 `approve` to the v4 PositionManager. The second call is the one that actually funds a deposit, and
   * it is invisible to anyone who only reads the ERC20 allowance.
   *
   * Field name trap: `lpTokens` entries are `{ tokenAddress, amount }`. Sending `{ address, amount }` is
   * rejected with `"lpTokens[0].tokenAddress" is not allowed to be empty`, which reads like a missing value
   * rather than a wrong key.
   */
  async checkApproval(params: {
    walletAddress: string
    token0: string
    token1: string
    amount0: string
    amount1: string
    action?: 'CREATE' | 'INCREASE' | 'DECREASE' | 'MIGRATE'
  }): Promise<CheckApprovalResponse> {
    return this.post(LP_HOST, '/lp/check_approval', {
      walletAddress: params.walletAddress,
      chainId: this.config.chainId,
      protocol: this.config.protocol,
      action: params.action ?? 'CREATE',
      generatePermitAsTransaction: true,
      simulateTransaction: false,
      lpTokens: [
        { tokenAddress: params.token0, amount: params.amount0 },
        { tokenAddress: params.token1, amount: params.amount1 },
      ],
    })
  }

  /**
   * Open the position.
   *
   * `newPool` is what removes every dependency on pre-existing testnet liquidity: we deploy both ERC20s, mint
   * them to ourselves, and have the API create the pool and the position in one call. The demo therefore owns
   * its own pool, which is what makes it deterministic and replayable.
   *
   * `newPool` takes `token0Address` and `token1Address`, like `existingPool`, and `initialPrice` is a
   * `sqrtRatioX96` string. Sending `token0`/`token1` fails the whole request with `"pool" does not match any of
   * the allowed types`, which names the union and not the offending key.
   *
   * The amount side is one object, `independentToken: { tokenAddress, amount }`. There is no separate
   * `independentAmount`, and there is no `TOKEN_0` enum: the token is named by address, and sending a string
   * there fails with `cannot decode message uniswap.liquidity.v2.CreateToken from JSON`.
   *
   * What comes back is a `multicall(bytes[])` on the PositionManager, `[initializePool, modifyLiquidities]`,
   * with the position minted to `walletAddress`.
   */
  async createPosition(params: {
    walletAddress: string
    token0: string
    token1: string
    fee: number
    tickSpacing: number
    tickLower: number
    tickUpper: number
    independentToken: string
    independentAmount: string
    initialPrice: string
    hooks?: string
    slippageTolerance?: number
  }): Promise<CreatePositionResponse> {
    return this.post(LP_HOST, '/lp/create', {
      walletAddress: params.walletAddress,
      chainId: this.config.chainId,
      protocol: this.config.protocol,
      newPool: {
        token0Address: params.token0,
        token1Address: params.token1,
        fee: params.fee,
        tickSpacing: params.tickSpacing,
        hooks: params.hooks ?? '0x0000000000000000000000000000000000000000',
        initialPrice: params.initialPrice,
      },
      tickBounds: { tickLower: params.tickLower, tickUpper: params.tickUpper },
      independentToken: { tokenAddress: params.independentToken, amount: params.independentAmount },
      slippageTolerance: params.slippageTolerance ?? 0.5,
      simulateTransaction: false,
    })
  }

  /**
   * The unwind. Called once per fill, and its calldata goes verbatim into the `preTransferOutHookData` slice
   * of the taker traits.
   *
   * `liquidityPercentageToDecrease` is an integer in [1, 100]. A just-in-time withdrawal can therefore never
   * be exact: we round up and keep the surplus as float. That constraint is reported in FEEDBACK.md.
   *
   * Field type trap, and the reason `tokenId` is typed as it is here: `nftTokenId` must be sent as a JSON
   * string. A JSON number is rejected with `cannot decode field
   * uniswap.liquidity.v2.DecreasePositionRequest.nft_token_id from JSON: 37804`, which reads like a bad value
   * rather than a bad type. `number` is deliberately not in the parameter type, so the shape that produces
   * that error cannot be written by a caller, and `String()` below is what the wire needs.
   */
  async decrease(params: {
    walletAddress: string
    tokenId: string | bigint
    token0: string
    token1: string
    percent: number
    slippageTolerance?: number
  }): Promise<{ decrease: TransactionRequest; [k: string]: unknown }> {
    const percent = Math.min(100, Math.max(1, Math.ceil(params.percent)))
    return this.post(LP_HOST, '/lp/decrease', {
      walletAddress: params.walletAddress,
      chainId: this.config.chainId,
      protocol: this.config.protocol,
      nftTokenId: String(params.tokenId),
      token0Address: params.token0,
      token1Address: params.token1,
      liquidityPercentageToDecrease: percent,
      slippageTolerance: params.slippageTolerance ?? 0.5,
      simulateTransaction: false,
    })
  }

  /**
   * The refund. Its calldata goes into the `postTransferInHookData` slice.
   *
   * One side only: `independentToken` names the token and the amount, and the API computes the other leg from
   * live pool state. There is no two sided form of this request.
   *
   * `nftTokenId` is a JSON string here too, for the same reason as on `/lp/decrease`.
   */
  async increase(params: {
    walletAddress: string
    tokenId: string | bigint
    token0: string
    token1: string
    independentToken: string
    independentAmount: string
    slippageTolerance?: number
  }): Promise<{ increase: TransactionRequest; [k: string]: unknown }> {
    return this.post(LP_HOST, '/lp/increase', {
      walletAddress: params.walletAddress,
      chainId: this.config.chainId,
      protocol: this.config.protocol,
      nftTokenId: String(params.tokenId),
      token0Address: params.token0,
      token1Address: params.token1,
      independentToken: { tokenAddress: params.independentToken, amount: params.independentAmount },
      slippageTolerance: params.slippageTolerance ?? 0.5,
      simulateTransaction: false,
    })
  }

  /**
   * Fees the same capital earned while it was quoting. Closing panel of the demo.
   *
   * The position is named by `tokenId` here and by `nftTokenId` on `/lp/increase` and `/lp/decrease`, in the
   * same document, and this endpoint takes no token addresses at all. Sending `nftTokenId` here fails with
   * `ClaimFeesRequest validation error: "tokenId" is not allowed to be empty`, which names the field that is
   * missing rather than the field that was sent, so it reads as an empty value and not as a wrong key.
   */
  async claimFees(params: { walletAddress: string; tokenId: string | bigint }): Promise<any> {
    return this.post(LP_HOST, '/lp/claim_fees', {
      walletAddress: params.walletAddress,
      chainId: this.config.chainId,
      protocol: this.config.protocol,
      tokenId: String(params.tokenId),
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
