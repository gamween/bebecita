/**
 * The negative moment, shipped on chain so it can be demonstrated rather than described.
 *
 * The demo's strongest passage shows the same order book twice: once WITHOUT instruction 0x92, quoting a depth
 * nobody can deliver and dying at settlement, and once with it, settling. This script ships the first one.
 *
 * The program is `[0x51 XYCConcentrateSwap]` then `[0x02 Salt]`, the same curve with the same bounds as the
 * real book, and nothing else. It carries no maker hooks, so no unwind happens and the vault is left with the
 * float it actually holds. The virtual balance shipped against it is enormous, which is legal because
 * `Aqua.ship` performs no solvency check at all, and with no 0x92 in the program nothing brings the quote back
 * down to what the maker can pay. So the quote succeeds and the swap dies at `Aqua.sol:68`, on a
 * `safeTransferFrom` out of a wallet holding almost nothing. That failure is the entire argument for the
 * instruction.
 *
 * Why this ships under our own router rather than 1inch's official one, which would have been the better
 * theatre. The official `AquaSwapVMRouter` is deployed on Sepolia at `0x8fdd04dbf6111437b44bbca99c28882434e0958f`
 * and `Aqua.ship` does take the app as a parameter, so shipping under it is possible. It does not work, and the
 * reason is worth recording: that deployment is not the contract the published source builds. It computes
 * `hash(order)` identically, and Aqua registers the strategy under it correctly, but `quote()` reverts with
 * completely empty return data, and it does so even for an order that was never shipped, where the current
 * source reverts with `SafeBalancesForTokenNotInActiveStrategy` carrying its four arguments. Its runtime
 * bytecode is also a different size from a router built from that source. So the deployed official router is an
 * older or otherwise divergent build, and an order shaped for today's `swap-vm` is not one it can execute.
 *
 * Keeping the comparison on one router is the more rigorous experiment anyway: two programs, one instruction of
 * difference, everything else held constant. A second router would have been a confounding variable.
 */
import { createPublicClient, createWalletClient, http, getAddress, parseAbi, type Address, type Hex } from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'node:fs'

import { env } from './config.js'
import {
  assertCurveArithmeticFits,
  buildConcentrateArgs,
  buildOrder,
  concentrateBounds,
  encodeOrder,
  orderHash,
  type Order,
} from './aqua.js'

const DEPLOYMENTS = 'deployments/sepolia.json'


const OP_XYC_CONCENTRATE_SWAP = 0x51
const OP_SALT = 0x02

const byte = (n: number): Hex => `0x${n.toString(16).padStart(2, '0')}`
const info = (label: string, value: unknown) => console.log(`    ${label.padEnd(18)}${String(value)}`)

/**
 * The bare program: price on the concentrated curve, then a salt so the order hash can be varied.
 *
 * This is deliberately the same curve, with the same bounds, as the real book. The only difference between
 * the two screens is the one instruction, which is the point.
 */
function buildBareProgram(params: { concentrateArgs: Hex; salt: Hex }): Hex {
  const args = params.concentrateArgs
  const length = (args.length - 2) / 2
  if (length !== 64) throw new Error(`0x51 takes 64 bytes of arguments, got ${length}`)
  return `0x${[
    byte(OP_XYC_CONCENTRATE_SWAP).slice(2),
    byte(length).slice(2),
    args.slice(2),
    byte(OP_SALT).slice(2),
    byte(1).slice(2),
    params.salt.slice(2),
  ].join('')}`
}

/** An order with no maker hooks, because the vault would reject a hook fired by a router it does not know. */
function buildHooklessOrder(params: { maker: Address; tokenA: Address; tokenB: Address; program: Hex }): Order {
  const withHooks = buildOrder(params)
  // `buildOrder` sets HAS_POST_TRANSFER_IN_HOOK (bit 251) and HAS_PRE_TRANSFER_OUT_HOOK (bit 250). Clearing
  // them is what turns this into an order the official router can settle end to end on its own.
  const HOOK_BITS = (1n << 251n) | (1n << 250n)
  return { ...withHooks, traits: withHooks.traits & ~HOOK_BITS }
}

async function main() {
  const deployments = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
  const vault = getAddress(deployments.vault)
  const router = getAddress(deployments.router)
  const tokenA = getAddress(deployments.tokenA)
  const tokenB = getAddress(deployments.tokenB)
  const aqua = getAddress(deployments.aqua)

  const account = privateKeyToAccount(env.privateKey as Hex)
  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.rpcUrl) })
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(env.rpcUrl) })

  console.log('\nThe negative moment: the same book, without instruction 0x92\n')
  info('router', router)
  info('maker (vault)', vault)

  // The same curve bounds the real book uses, so the two screens differ by one instruction and nothing else.
  const pool = deployments.pool
  const record = deployments.strategy ?? {}
  const bounds =
    record.sqrtPriceMin && record.sqrtPriceMax
      ? { sqrtPriceMin: BigInt(record.sqrtPriceMin), sqrtPriceMax: BigInt(record.sqrtPriceMax) }
      : concentrateBounds({
          sqrtPriceX96: BigInt(record.sqrtPriceX96 ?? 0),
          tickLower: pool.tickLower,
          tickUpper: pool.tickUpper,
        })
  const concentrateArgs = buildConcentrateArgs(bounds)

  // Walk the salt space so a re-run never collides: a strategy hash can be shipped exactly once, ever.
  const [token0, token1] =
    tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA]

  let order: Order | undefined
  let hash: Hex | undefined
  for (let candidate = 0xb0; candidate <= 0xff; candidate++) {
    const program = buildBareProgram({ concentrateArgs, salt: byte(candidate) })
    const attempt = buildHooklessOrder({ maker: vault, tokenA, tokenB, program })
    const attemptHash = orderHash(attempt)
    const [existing] = await publicClient.readContract({
      address: aqua,
      abi: parseAbi([
        'function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248, uint8)',
      ]),
      functionName: 'rawBalances',
      args: [vault, router, attemptHash, token0],
    })
    if (existing === 0n) {
      order = attempt
      hash = attemptHash
      info('salt', byte(candidate))
      break
    }
  }
  if (!order || !hash) throw new Error('no free salt found in 0xb0..0xff')

  // Ship exactly what the live book ships, so the two screens differ by one instruction and nothing else.
  //
  // That matters more than it looks. A flat, enormous balance on both sides would also prove the point, but it
  // would quote a price hundreds of times off parity, and a judge would rightly read that as a broken book
  // rather than as an unbacked one. Reusing the real asymmetric figures keeps the price recognisable: the two
  // books quote the same kind of number, one of them can settle it and the other cannot.
  const live = deployments.strategy?.shipped
  if (!live?.token0 || !live?.token1) {
    throw new Error('no shipped amounts in the strategy record, run yarn aqua first')
  }
  const [amount0, amount1] = [BigInt(live.token0), BigInt(live.token1)]
  assertCurveArithmeticFits({
    balanceLt: amount0,
    balanceGt: amount1,
    sqrtPriceMin: bounds.sqrtPriceMin,
    sqrtPriceMax: bounds.sqrtPriceMax,
  })

  info('orderHash', hash)
  info('shipping token0', amount0)
  info('shipping token1', amount1)

  const shipTx = await wallet.writeContract({
    address: vault,
    abi: parseAbi([
      'function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)',
    ]),
    functionName: 'ship',
    args: [router, encodeOrder(order), [token0, token1], [amount0, amount1]],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: shipTx })
  if (receipt.status !== 'success') throw new Error(`ship reverted, ${shipTx}`)
  info('shipped', `${shipTx}  gas ${receipt.gasUsed}`)

  // Prove the story rather than assume it: the book must quote, and must quote more than the vault can pay.
  const amountIn = 1_000n * 10n ** 18n
  const takerTraits = `0x${'00'.repeat(20)}00c1` as Hex // ten empty slice indexes, then isExactIn | useTransferFromAndAquaPush | isAToB
  const [, quotedOut] = await publicClient.readContract({
    address: router,
    abi: parseAbi([
      'function quote((address maker,uint256 traits,bytes data) order, uint256 amount, bytes takerTraitsAndData) view returns (uint256, uint256, bytes32)',
    ]),
    functionName: 'quote',
    args: [order, amountIn, takerTraits],
  })

  const float = await publicClient.readContract({
    address: token1,
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [vault],
  })

  console.log('')
  info('quote without 0x92', `${quotedOut} out for ${amountIn} in`)
  info('vault can pay', float)
  if (quotedOut <= float) {
    console.log('\n  WARNING: the quote is smaller than the float, so the swap would succeed.')
    console.log('  Run yarn rebalance or raise the quoted size before demonstrating this.')
  } else {
    const factor = Number(quotedOut) / Number(float === 0n ? 1n : float)
    console.log(`\n  Without 0x92 the book quotes ${factor.toFixed(1)}x what the maker can actually pay.`)
    console.log('  A swap against it dies at Aqua.sol:68, safeTransferFrom out of a wallet that is almost empty.')
  }

  deployments.negativeMoment = {
    app: router,
    orderHash: hash,
    shipTx,
    shipped: { token0: amount0.toString(), token1: amount1.toString() },
    order: { maker: order.maker, traits: order.traits.toString(), data: order.data },
    note: 'hookless [0x51][0x02] program on our router, no 0x92, so the quote is never clamped',
  }
  writeFileSync(DEPLOYMENTS, `${JSON.stringify(deployments, null, 2)}\n`)
  console.log(`\n  written to        ${DEPLOYMENTS}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
