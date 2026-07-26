/**
 * Trade the maker's inventory home. Run with `yarn rebalance`, between fills, never inside one.
 *
 * Why this command has to exist, and it is not a bug being patched.
 *
 * Decreasing a v4 position returns both tokens pro rata. A fill then pays the taker in one token only and
 * receives the other from the taker. So on a book that trades in one direction, every fill sells bALPHA and
 * buys bBRAVO, and the redeposit through `/lp/increase` is two sided and therefore capped by whichever token is
 * scarce, which is the one the maker keeps selling. It can put back a few percent of what the unwind removed
 * and no more. The rest piles up as free float in the token nobody is buying, and the position shrinks by the
 * difference. Fourteen fills took this position from 100,000 of liquidity to 92,140 and left 21,859 bBRAVO
 * sitting in a vault whose entire claim is that it holds almost nothing.
 *
 * That is not a defect of this design. A market maker that only ever sees one side of the flow accumulates
 * inventory, always, and the only way out is to trade it. The round trip is not balance neutral and the spread
 * has to cover the cost of the eventual trade home. See `docs/ARCHITECTURE.md`, section Inventory.
 *
 * What this does, in one sentence: it sells the surplus token for the scarce one at the pool, then puts both
 * sides back into the position, so the float returns to near zero and the liquidity returns toward what the
 * position opened with.
 *
 * Where it runs, and why that answers the only hard question here. `BebecitaVault.sweep` is owner only and
 * already exists, so nothing on chain has to change: the vault is the book and the owner is the desk. The
 * vault cannot execute a Universal Router swap anyway, because it forwards `modifyLiquidities` to the pinned
 * position manager and nothing else, which is exactly the property that makes taker supplied calldata safe.
 * So the traded leg leaves the vault, is swapped by the desk, and comes back. Only that leg ever moves: the
 * part of the surplus that is not being sold never leaves the book.
 *
 * The sizing is a single sided zap, not a dump. Selling the whole surplus would leave the vault holding a pure
 * bALPHA bag against a pool priced where that sale left it, and a two sided deposit would then be capped at
 * nothing, which is the same trap one level down. The amount sold is the one that leaves the remaining surplus
 * and the swap proceeds in the pool's own post trade ratio, so both sides go back in and nothing is left over.
 *
 * One honest consequence, stated here because it is the interesting part. This pool's only liquidity provider
 * is the vault itself, so the rebalance trades against the maker's own position: the 0.3% fee comes back and
 * the price impact lands on the book it came from. What moves for real is the pool price, from the parity it
 * had held through all fourteen fills, because a decrease and an increase are both pro rata and never move a
 * pool. This is the first operation in this project that does, and it has to be: the inventory imbalance is
 * real, and in a closed system the price is where that imbalance shows up. Read the last panel this script
 * prints, which measures what that does to the maker's conversion factor.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import { SEPOLIA, env } from './config.js'
import { bindingSide } from './sizing.js'
import { loadStrategy, readDeployments, writeDeployments } from './strategy.js'
import { UniswapClient, type TransactionRequest } from './uniswap.js'

/** v4 prices in Q64.96 throughout, so every conversion below is one multiply and one divide. */
const Q96 = 2n ** 96n
const WAD = 10n ** 18n

/** Slippage on the rebalance swap, in percent, as the trade API takes it. */
const SWAP_SLIPPAGE_PCT = 1

/**
 * The swap has to come back within this much of the constant product estimate computed from the position's own
 * liquidity. It is a sanity check on the route rather than a price control: a quote far off this means the API
 * priced something that is not the pool funding the book, and the route assertion below would have caught it,
 * so failing both would mean the pool moved under us between two reads.
 */
const QUOTE_FLOOR_BPS = 9_000n

/**
 * Share of the binding side the redeposit asks for, and what it falls back to.
 *
 * `/lp/increase` names one token and computes the other from live pool state. Asking for the full balance
 * leaves no room for the rounding between that computation and what the position manager settles at, and a
 * redeposit that comes up one wei short reverts inside Permit2. Each attempt is checked against the vault's
 * real balances before anything is broadcast, so the fallbacks only ever cost an API call.
 */
const DEPOSIT_SHARES_BPS = [9_999n, 9_990n, 9_950n, 9_800n, 9_500n]

/** Below this, the book is balanced enough that a swap would cost more than the drift is worth. */
const DRIFT_FLOOR_BPS = 10n

const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
])

const vaultAbi = parseAbi([
  'function OWNER() view returns (address)',
  'function reachableFromPosition() view returns (uint256)',
  'function sweep(address token, address to, uint256 amount)',
  'function executeOnPositionManager(bytes payload, uint256 value) payable returns (bytes)',
])

const posmAbi = parseAbi(['function getPositionLiquidity(uint256 tokenId) view returns (uint128)'])

const stateViewAbi = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
])

const step = (n: number, label: string) => console.log(`\n[${n}] ${label}`)
const info = (label: string, value: unknown = '') => console.log(`    ${label}${value === '' ? '' : `  ${value}`}`)
const tokens = (amount: bigint, symbol: string) => `${formatUnits(amount, 18)} ${symbol}`

/**
 * Token amounts held by a full range position, from its liquidity and the pool's current price.
 *
 * The general form subtracts the position's own bounds. At ticks -887220 and 887220 those terms are
 * `sqrt(1.0001^-887220)`, about 5.4e-20, and its reciprocal, so they move the answer by roughly one part in
 * 1e19 and are dropped here on purpose rather than by omission: reproducing tick math in the solver to recover
 * a billionth of a wei would be the same mistake `docs/ARCHITECTURE.md` records not making on chain. Every
 * number this drives is checked against the API's own answer or against a realised balance afterwards.
 */
function reservesOf(liquidity: bigint, sqrtPriceX96: bigint): { amount0: bigint; amount1: bigint } {
  return { amount0: (liquidity * Q96) / sqrtPriceX96, amount1: (liquidity * sqrtPriceX96) / Q96 }
}

/** Constant product with the pool's fee taken off the input, which is what a v4 swap does. */
function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feePips: number): bigint {
  const net = (amountIn * BigInt(1_000_000 - feePips)) / 1_000_000n
  return (reserveOut * net) / (reserveIn + net)
}

/**
 * How much of the surplus token to sell so that what is left pairs exactly with what the sale buys.
 *
 * The target is the ratio the pool itself will be at afterwards, because that is the ratio a two sided deposit
 * consumes: sell too little and the leftover surplus cannot be deposited, sell too much and the proceeds
 * cannot. Both legs of that trade move the ratio, the sale by moving the price and the proceeds by changing
 * what is held, so this is solved rather than divided. Bisection, in integers, on a function that is monotone
 * in the amount sold and changes sign inside the interval by construction.
 */
function zapAmount(params: {
  heldSurplus: bigint
  heldOther: bigint
  reserveSurplus: bigint
  reserveOther: bigint
  feePips: number
}): bigint {
  let low = 0n
  let high = params.heldSurplus
  while (high - low > 1n) {
    const mid = (low + high) / 2n
    const bought = amountOut(mid, params.reserveSurplus, params.reserveOther, params.feePips)
    const stillSurplus = (params.heldSurplus - mid) * (params.reserveOther - bought)
    const nowPaired = (params.heldOther + bought) * (params.reserveSurplus + mid)
    if (stillSurplus > nowPaired) low = mid
    else high = mid
  }
  return low
}

interface Book {
  float0: bigint
  float1: bigint
  liquidity: bigint
  reachable: bigint
  sqrtPriceX96: bigint
  tick: number
  poolLiquidity: bigint
}

async function main() {
  const dry = process.argv.includes('--dry')
  const deployments = readDeployments()
  const strategy = loadStrategy(deployments)
  const account = privateKeyToAccount(env.privateKey as Hex)
  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.rpcUrl) })
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(env.rpcUrl) })
  const uniswap = new UniswapClient({ apiKey: env.apiKey, chainId: SEPOLIA.chainId, protocol: 'V4' })

  const vault = strategy.params.vault
  const positionManager = strategy.params.positionManager
  const stateView = getAddress(SEPOLIA.stateView)
  const tokenId = strategy.params.tokenId
  const { token0, token1 } = strategy

  const pool = deployments.pool
  if (!pool?.poolId) throw new Error('no pool in deployments/sepolia.json, run yarn setup first')
  const poolId = pool.poolId as Hex
  const feePips = pool.fee

  /** What the position opened with, which is the number the restore aims at. */
  const openingLiquidity = BigInt((deployments.position as { liquidity?: string })?.liquidity ?? 0)

  const owner = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'OWNER' })
  if (getAddress(owner) !== account.address) {
    throw new Error(
      `the vault's owner is ${owner} and DEPLOYER_PRIVATE_KEY is ${account.address}. sweep, ` +
        'executeOnPositionManager and the whole desk side of this operation are owner only.',
    )
  }

  const [symbol0, symbol1] = await Promise.all([
    publicClient.readContract({ address: token0, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({ address: token1, abi: erc20Abi, functionName: 'symbol' }),
  ])
  const symbolOf = (token: Address) => (token === token0 ? symbol0 : symbol1)

  const readBook = async (): Promise<Book> => {
    const [float0, float1, liquidity, reachable, slot0, poolLiquidity] = await Promise.all([
      publicClient.readContract({ address: token0, abi: erc20Abi, functionName: 'balanceOf', args: [vault] }),
      publicClient.readContract({ address: token1, abi: erc20Abi, functionName: 'balanceOf', args: [vault] }),
      publicClient.readContract({ address: positionManager, abi: posmAbi, functionName: 'getPositionLiquidity', args: [tokenId] }),
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'reachableFromPosition' }),
      publicClient.readContract({ address: stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolId] }),
      publicClient.readContract({ address: stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [poolId] }),
    ])
    return { float0, float1, liquidity, reachable, sqrtPriceX96: slot0[0], tick: slot0[1], poolLiquidity }
  }

  const panel = (book: Book) => {
    const reserves = reservesOf(book.liquidity, book.sqrtPriceX96)
    const price = (book.sqrtPriceX96 * book.sqrtPriceX96 * WAD) / (Q96 * Q96)
    info('float           ', `${tokens(book.float0, symbol0)} / ${tokens(book.float1, symbol1)}`)
    info('position        ', `${formatUnits(book.liquidity, 18)} of liquidity, tokenId ${tokenId}`)
    info('holds           ', `${tokens(reserves.amount0, symbol0)} + ${tokens(reserves.amount1, symbol1)}`)
    info('reachable       ', `${tokens(book.reachable, symbol1)}, what reachableFromPosition() reports`)
    info('pool            ', `tick ${book.tick}, ${formatUnits(price, 18)} ${symbol1} per ${symbol0}`)
    return reserves
  }

  /** Simulates first, because a failing eth_call carries a reason and a failing broadcast carries a gas bill. */
  const send = async (label: string, tx: { to: Address; data: Hex; value?: bigint }) => {
    await publicClient.call({ account: account.address, to: tx.to, data: tx.data, value: tx.value ?? 0n })
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0n })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${label} reverted, ${hash}`)
    info(`${label}`, `${hash}  gas ${receipt.gasUsed}`)
    return hash
  }

  console.log('\nBebecita rebalance, Ethereum Sepolia')
  info('desk (owner)    ', account.address)
  info('book (vault)    ', vault)
  info('position        ', `tokenId ${tokenId}, pool ${poolId}`)
  if (dry) info('mode            ', 'dry run, the API is called for real and nothing is broadcast')

  // -------------------------------------------------------------------
  step(1, 'read the book')
  // -------------------------------------------------------------------

  const before = await readBook()
  const reservesBefore = panel(before)
  if (before.liquidity !== before.poolLiquidity) {
    info('note            ', `the pool carries ${formatUnits(before.poolLiquidity, 18)} of liquidity, so this position is not its only one`)
  }

  // -------------------------------------------------------------------
  step(2, 'size the trade, and say what it is aiming at')
  // -------------------------------------------------------------------

  // Surplus is measured against the ratio a deposit consumes, not against the other float. A vault holding
  // twice as much of one token as the other is balanced if the pool is priced at two.
  const surplusIsToken0 = before.float0 * reservesBefore.amount1 > before.float1 * reservesBefore.amount0
  const [surplusToken, scarceToken] = surplusIsToken0 ? [token0, token1] : [token1, token0]
  const [heldSurplus, heldOther] = surplusIsToken0 ? [before.float0, before.float1] : [before.float1, before.float0]
  const [reserveSurplus, reserveOther] = surplusIsToken0
    ? [reservesBefore.amount0, reservesBefore.amount1]
    : [reservesBefore.amount1, reservesBefore.amount0]

  const sell = zapAmount({ heldSurplus, heldOther, reserveSurplus, reserveOther, feePips })
  const estimate = amountOut(sell, reserveSurplus, reserveOther, feePips)

  info('surplus         ', `${tokens(heldSurplus, symbolOf(surplusToken))}, against ${tokens(heldOther, symbolOf(scarceToken))} to pair it with`)
  info('target          ', `the position back toward the ${formatUnits(openingLiquidity, 18)} of liquidity it opened with`)
  info('target          ', 'the float back to near zero, which is the state the whole project claims')
  info('sell            ', `${tokens(sell, symbolOf(surplusToken))}, the amount that leaves both sides in the pool ratio`)
  info('keep            ', `${tokens(heldSurplus - sell, symbolOf(surplusToken))} in the vault, it never leaves`)
  info('estimate        ', `${tokens(estimate, symbolOf(scarceToken))} back, on the position's own reserves`)

  // The trade and the redeposit are two independent halves on purpose. A run whose swap succeeded and whose
  // redeposit did not must be able to finish the job on a second run, and by then the float is already in the
  // pool's ratio, so the sizing above correctly asks for nothing and only step 7 has work left.
  const tradeNeeded = sell > 0n && sell * 10_000n >= heldSurplus * DRIFT_FLOOR_BPS

  let sold = 0n
  let bought = 0n
  let sweepHash: Hex | null = null
  let approveHash: Hex | null = null
  let swapHash: Hex | null = null
  let returnHash: Hex | null = null

  if (!tradeNeeded) {
    info('nothing to sell ', 'the float already sits in the pool ratio, so this run only redeposits')
  } else {
    sold = sell

    // -------------------------------------------------------------------
    step(3, 'sweep the traded leg out to the desk')
    // -------------------------------------------------------------------

    if (dry) info('would sweep     ', `${tokens(sold, symbolOf(surplusToken))} from the vault to ${account.address}`)
    else sweepHash = await send('sweep           ', { to: vault, data: encodeSweep(surplusToken, account.address, sold) })

    const deskBefore = await publicClient.readContract({
      address: scarceToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })

    // -------------------------------------------------------------------
    step(4, 'POST /check_approval on the trade host, permit2 disabled')
    // -------------------------------------------------------------------

    const approval = await uniswap.tradeApproval({
      walletAddress: account.address,
      token: surplusToken,
      amount: sold.toString(),
    })
    if (!approval.approval) {
      info('approval        ', 'the API considers the desk already approved')
    } else {
      const spender = spenderOf(approval.approval.data as Hex)
      info('spender         ', `${spender}, named by the API rather than hardcoded here`)
      if (dry) info('would approve   ', `${symbolOf(surplusToken)} -> ${spender}`)
      else {
        approveHash = await send('approve         ', {
          to: getAddress(approval.approval.to) as Address,
          data: approval.approval.data as Hex,
        })
      }
    }

    // -------------------------------------------------------------------
    step(5, 'POST /quote then POST /swap, and execute against the Universal Router')
    // -------------------------------------------------------------------

    const quote = await uniswap.tradeQuote({
      swapper: account.address,
      tokenIn: surplusToken,
      tokenOut: scarceToken,
      amountIn: sold.toString(),
      slippageTolerancePct: SWAP_SLIPPAGE_PCT,
    })

    const quotedOut = BigInt(quote.quote.output.amount)
    const minimumOut = BigInt(quote.quote.output.minimumAmount ?? quote.quote.output.amount)
    info('routing         ', quote.routing)
    info('permitData      ', `${quote.permitData}, which is what x-permit2-disabled buys`)
    info('quoted          ', `${tokens(quotedOut, symbolOf(scarceToken))} out, minimum ${formatUnits(minimumOut, 18)}`)
    info('price impact    ', `${quote.quote.priceImpact ?? 'n/a'}%, which lands on this position because it is the only LP here`)
    info('route           ', quote.quote.routeString ?? 'n/a')
    info('api quota left  ', uniswap.remainingQuota ?? 'n/a')

    // The rebalance must trade in the pool that funds the book. Anywhere else and the position would be topped
    // up with tokens bought from a market this project does not control, which is a different operation.
    const routed = quote.quote.route?.flat() ?? []
    if (routed.length !== 1 || routed[0]!.address.toLowerCase() !== poolId.toLowerCase()) {
      throw new Error(
        `the route is ${quote.quote.routeString ?? JSON.stringify(routed)}, and this rebalance only trades in ` +
          `the pool that funds the book, ${poolId}`,
      )
    }
    if (quotedOut * 10_000n < estimate * QUOTE_FLOOR_BPS) {
      throw new Error(
        `the API quotes ${formatUnits(quotedOut, 18)} where the position's own reserves price ` +
          `${formatUnits(estimate, 18)}. Something moved the pool between the two reads.`,
      )
    }

    const swap = await uniswap.tradeSwap({ quote: quote.quote })
    info('swap target     ', swap.swap.to)
    info('calldata        ', `${((swap.swap.data as string).length - 2) / 2} bytes`)

    bought = quotedOut
    if (dry) {
      info('would swap      ', `${tokens(sold, symbolOf(surplusToken))} -> ${tokens(quotedOut, symbolOf(scarceToken))}`)
    } else {
      swapHash = await send('swap            ', {
        to: getAddress(swap.swap.to) as Address,
        data: swap.swap.data as Hex,
        value: swap.swap.value ? BigInt(swap.swap.value) : 0n,
      })
      const deskAfter = await publicClient.readContract({
        address: scarceToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      })
      bought = deskAfter - deskBefore
      info('realised        ', `${tokens(bought, symbolOf(scarceToken))}, read off the desk's balance and not off the quote`)
    }

    // -------------------------------------------------------------------
    step(6, 'send the proceeds back to the book')
    // -------------------------------------------------------------------

    if (dry) info('would transfer  ', `${tokens(bought, symbolOf(scarceToken))} back to ${vault}`)
    else returnHash = await send('return          ', { to: scarceToken, data: encodeErc20Transfer(vault, bought) })
  }

  // -------------------------------------------------------------------
  step(7, 'POST /lp/increase, executed by the vault')
  // -------------------------------------------------------------------

  const mid = dry ? before : await readBook()
  const reservesMid = reservesOf(mid.liquidity, mid.sqrtPriceX96)
  // In a dry run nothing moved, so model the state the redeposit would face rather than pretending it did.
  const held0 = dry ? (surplusIsToken0 ? before.float0 - sold : before.float0 + bought) : mid.float0
  const held1 = dry ? (surplusIsToken0 ? before.float1 + bought : before.float1 - sold) : mid.float1
  const reserve0 = dry ? reservesMid.amount0 + (surplusIsToken0 ? sold : -bought) : reservesMid.amount0
  const reserve1 = dry ? reservesMid.amount1 + (surplusIsToken0 ? -bought : sold) : reservesMid.amount1

  info('vault holds     ', `${tokens(held0, symbol0)} / ${tokens(held1, symbol1)}`)
  info('pool ratio      ', `${formatUnits((reserve1 * WAD) / reserve0, 18)} ${symbol1} per ${symbol0}`)

  if (held0 === 0n || held1 === 0n) {
    throw new Error(
      'the vault holds nothing on one side, so a two sided redeposit is impossible. That is the state this ' +
        'command exists to leave behind, not one it can start from.',
    )
  }

  // Which side runs out first decides which one names the deposit, because the API computes the other leg from
  // the pool and will happily name an amount the vault does not hold. Same function the fill sizes its
  // redeposit with, for the same reason, so there is one copy of that comparison in the repository.
  const binding = bindingSide(
    { token: token0, held: held0, reserve: reserve0 },
    { token: token1, held: held1, reserve: reserve1 },
  )
  const independentToken = binding.token
  const independentHeld = binding.held
  info('binding side    ', `${symbolOf(independentToken)}, so it names the deposit and the API computes the other leg`)

  let increase: { increase: TransactionRequest; token0?: unknown; token1?: unknown } | null = null
  let asked0 = 0n
  let asked1 = 0n
  for (const share of DEPOSIT_SHARES_BPS) {
    const independentAmount = (independentHeld * share) / 10_000n
    const attempt = await uniswap.increase({
      walletAddress: vault,
      tokenId: tokenId.toString(),
      token0,
      token1,
      independentToken,
      independentAmount: independentAmount.toString(),
    })
    asked0 = BigInt((attempt.token0 as { amount: string }).amount)
    asked1 = BigInt((attempt.token1 as { amount: string }).amount)
    info('/lp/increase    ', `${formatUnits(share, 2)}% of the binding side -> ${tokens(asked0, symbol0)} + ${tokens(asked1, symbol1)}`)
    if (asked0 <= held0 && asked1 <= held1) {
      increase = attempt
      break
    }
    info('rejected        ', 'the computed leg is larger than the vault holds, asking for less')
  }
  if (!increase) throw new Error('every deposit size the API computed asked for more than the vault holds')

  if (getAddress(increase.increase.to) !== positionManager) {
    throw new Error('the API built calldata for a contract other than the pinned position manager')
  }
  info('target          ', increase.increase.to)
  info('calldata        ', `${((increase.increase.data as string).length - 2) / 2} bytes`)

  let increaseHash: Hex | null = null
  if (dry) info('would execute   ', 'through BebecitaVault.executeOnPositionManager, owner only')
  else {
    increaseHash = await send('increase        ', { to: vault, data: encodeExecute(increase.increase.data as Hex) })
  }

  // -------------------------------------------------------------------
  step(8, 'read the book back')
  // -------------------------------------------------------------------

  if (dry) {
    console.log('\nDry run only. The same command without --dry sweeps, swaps and redeposits.\n')
    return
  }

  const after = await readBook()
  panel(after)

  console.log('\n    What moved')
  const drift = (label: string, from: bigint, to: bigint) => {
    const delta = to - from
    info(label, `${formatUnits(from, 18)} -> ${formatUnits(to, 18)}  (${delta >= 0n ? '+' : ''}${formatUnits(delta, 18)})`)
  }
  drift(`  float ${symbol0.padEnd(9)}`, before.float0, after.float0)
  drift(`  float ${symbol1.padEnd(9)}`, before.float1, after.float1)
  drift('  liquidity     ', before.liquidity, after.liquidity)
  drift('  reachable     ', before.reachable, after.reachable)
  if (openingLiquidity > 0n) {
    const restored = (after.liquidity * 10_000n) / openingLiquidity
    info('  vs opening    ', `${formatUnits(restored, 2)}% of the ${formatUnits(openingLiquidity, 18)} the position opened with`)
  }

  // The conversion factor is the one number a rebalance changes that nothing on chain will notice on its own.
  // A unit of full range liquidity is worth sqrt(price) of token1 and 1/sqrt(price) of token0, so it is exactly
  // 1 of each only while the pool sits at parity. Trading the inventory home is what moves the pool off parity,
  // which means the maker parameter compiled into the shipped program stops being the truth at that moment.
  const unitsToken1 = (after.sqrtPriceX96 * WAD) / Q96
  const unitsToken0 = (Q96 * WAD) / after.sqrtPriceX96
  const shipped = strategy.params.unitsPerLiquidityE18
  console.log('\n    The maker parameter this moved')
  info('  shipped       ', `unitsPerLiquidityE18 ${formatUnits(shipped, 18)}, compiled into the 0x92 arguments`)
  info('  measured      ', `${formatUnits(unitsToken1, 18)} ${symbol1} and ${formatUnits(unitsToken0, 18)} ${symbol0} per unit of liquidity`)
  if (unitsToken1 * 100n < shipped * 99n) {
    const overstated = (shipped * 10_000n) / unitsToken1 - 10_000n
    info('  consequence   ', `0x92 now clamps against ${formatUnits(overstated, 2)}% more ${symbol1} than the position can release`)
    info('  fix           ', `re-ship the book with unitsPerLiquidityE18 ${unitsToken1}, which is yarn aqua after setting it`)
    info('  and           ', 'setRiskParams on the vault with the same number, so URC-3 reporting matches the clamp')
  }

  deployments.rebalance = {
    at: new Date().toISOString(),
    sold: { token: surplusToken, amount: sell.toString(), symbol: symbolOf(surplusToken) },
    bought: { token: scarceToken, amount: bought.toString(), symbol: symbolOf(scarceToken) },
    deposited: { token0: asked0.toString(), token1: asked1.toString() },
    before: {
      float0: before.float0.toString(),
      float1: before.float1.toString(),
      liquidity: before.liquidity.toString(),
      reachable: before.reachable.toString(),
      sqrtPriceX96: before.sqrtPriceX96.toString(),
    },
    after: {
      float0: after.float0.toString(),
      float1: after.float1.toString(),
      liquidity: after.liquidity.toString(),
      reachable: after.reachable.toString(),
      sqrtPriceX96: after.sqrtPriceX96.toString(),
    },
    unitsPerLiquidityE18Measured: unitsToken1.toString(),
    txs: {
      sweep: sweepHash,
      approve: approveHash,
      swap: swapHash,
      returnToVault: returnHash,
      increase: increaseHash,
    },
  }
  writeDeployments(deployments)
  console.log('\n    written to      deployments/sepolia.json, under rebalance')
  console.log(`\nRebalanced. https://sepolia.etherscan.io/tx/${swapHash}\n`)
}

/** `approve(address,uint256)` payloads carry the spender in the first argument word. */
function spenderOf(data: Hex): Address {
  return getAddress(`0x${data.slice(34, 74)}`) as Address
}

const encodeErc20Transfer = (to: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] })

const encodeSweep = (token: Address, to: Address, amount: bigint): Hex =>
  encodeFunctionData({ abi: vaultAbi, functionName: 'sweep', args: [token, to, amount] })

const encodeExecute = (payload: Hex): Hex =>
  encodeFunctionData({ abi: vaultAbi, functionName: 'executeOnPositionManager', args: [payload, 0n] })

main().catch((error) => {
  console.error(`\n${error}`)
  process.exit(1)
})
