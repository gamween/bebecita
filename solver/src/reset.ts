/**
 * One command that makes the demo replayable: `yarn demo:reset`.
 *
 * A strategy hash can be shipped exactly once, ever. `Aqua.ship` requires `tokensCount == 0` for every token
 * and `Aqua.dock` sets it to `0xff` permanently, so the second run of an unchanged program reverts with
 * `StrategiesMustBeImmutable`. A demo that cannot be replayed is a demo that fails live, in front of a judge,
 * at the one moment it matters, so re-salting is not a convenience script.
 *
 * What this does, and deliberately nothing else. It rebuilds the order that is currently recorded and proves
 * it against the hash `yarn aqua` shipped, so the parameters are known good before anything is changed. It
 * then walks the salt space looking for a program Aqua has never seen, ships that one from the vault with the
 * same balances and the same risk parameters, and reads the result back out of Aqua. The pool, the position,
 * the vault and the router are untouched: the only thing that moves is one byte of a no-op instruction.
 *
 * The salt is one byte, so there are 256 strategies available. This picks the next unused one rather than a
 * random one, because a random byte collides with an already shipped strategy after about twenty runs and the
 * revert that surfaces says nothing about salts.
 */
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import { encodeOrder } from './aqua.js'
import { env } from './config.js'
import { composeOrder, loadStrategy, readDeployments, writeDeployments } from './strategy.js'

const SALT_SPACE = 256

const aquaAbi = parseAbi([
  'function rawBalances(address maker, address app, bytes32 strategyHash, address token) view returns (uint248 balance, uint8 tokensCount)',
  'function safeBalances(address maker, address app, bytes32 strategyHash, address token0, address token1) view returns (uint256, uint256)',
])

const vaultAbi = parseAbi([
  'function ship(address app, bytes strategy, address[] tokens, uint256[] amounts) returns (bytes32)',
  'function TOKEN_ID() view returns (uint256)',
])

const routerAbi = parseAbi([
  'struct Order { address maker; uint256 traits; bytes data; }',
  'function hash(Order order) view returns (bytes32)',
])

const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
])

const step = (n: number, label: string) => console.log(`\n[${n}] ${label}`)
const info = (label: string, value: unknown = '') => console.log(`    ${label}${value === '' ? '' : `  ${value}`}`)

async function main() {
  const deployments = readDeployments()
  const current = loadStrategy(deployments)
  const account = privateKeyToAccount(env.privateKey as Hex)
  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.rpcUrl) })
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(env.rpcUrl) })

  const router = getAddress(deployments.router)
  const aqua = getAddress(deployments.aqua)
  const vault = current.params.vault
  const { token0, token1 } = current
  const shippedBalance = BigInt(current.record.shippedBalance)

  console.log('\nBebecita demo reset, Ethereum Sepolia')
  info('vault           ', vault)
  info('router          ', router)
  info('current salt    ', current.record.salt)
  info('current hash    ', current.orderHash)

  // The vault's tokenId is immutable, so a strategy priced against a different one would quote depth that
  // belongs to somebody else's position.
  const vaultTokenId = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: 'TOKEN_ID' })
  if (vaultTokenId !== current.params.tokenId) {
    throw new Error(`vault ${vault} points at tokenId ${vaultTokenId}, deployments say ${current.params.tokenId}`)
  }

  // -------------------------------------------------------------------
  step(1, 'walk the salt space for a program Aqua has never seen')
  // -------------------------------------------------------------------

  const startsAt = (Number(BigInt(current.record.salt)) + 1) % SALT_SPACE
  let chosen: { salt: Hex; order: ReturnType<typeof composeOrder>; hash: Hex } | undefined
  let probed = 0

  for (let offset = 0; offset < SALT_SPACE; offset++) {
    const salt = toHex((startsAt + offset) % SALT_SPACE, { size: 1 })
    const order = composeOrder({ ...current.params, salt })
    const hash = keccak256(encodeOrder(order))
    probed++

    const [, tokensCount] = await publicClient.readContract({
      address: aqua,
      abi: aquaAbi,
      functionName: 'rawBalances',
      args: [vault, router, hash, token0],
    })
    if (tokensCount === 0) {
      chosen = { salt, order, hash }
      break
    }
  }

  if (!chosen) {
    throw new Error(
      `all ${SALT_SPACE} single byte salts have been shipped for this vault. Open a new position with ` +
        'yarn setup --recreate, which redeploys the vault and gives the salt space back.',
    )
  }

  info('probed          ', `${probed} salt${probed === 1 ? '' : 's'} from ${toHex(startsAt, { size: 1 })}`)
  info('fresh salt      ', chosen.salt)
  info('new hash        ', chosen.hash)

  // The router derives the same hash from the same order. Checking it before shipping means a mismatch costs
  // nothing, where discovering it later costs a reverted fill with no useful revert data.
  const routerHash = await publicClient.readContract({
    address: router,
    abi: routerAbi,
    functionName: 'hash',
    args: [chosen.order],
  })
  if (routerHash !== chosen.hash) {
    throw new Error(`router.hash is ${routerHash}, keccak256(abi.encode(order)) is ${chosen.hash}`)
  }

  // -------------------------------------------------------------------
  step(2, 'ship it from the vault')
  // -------------------------------------------------------------------

  const strategy = encodeOrder(chosen.order)
  const hash = await wallet.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'ship',
    args: [router, strategy, [token0, token1], [shippedBalance, shippedBalance]],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error(`ship reverted, ${hash}. A repeated strategy hash reverts with StrategiesMustBeImmutable`)
  }
  info('shipped         ', `${hash}  gas ${receipt.gasUsed}`)

  const [balance0, balance1] = await publicClient.readContract({
    address: aqua,
    abi: aquaAbi,
    functionName: 'safeBalances',
    args: [vault, router, chosen.hash, token0, token1],
  })
  if (balance0 !== shippedBalance || balance1 !== shippedBalance) {
    throw new Error('Aqua stored a different balance than the one shipped')
  }
  info('aqua balances   ', `${formatUnits(balance0, 18)} / ${formatUnits(balance1, 18)}`)

  deployments.strategy = {
    ...current.record,
    orderHash: chosen.hash,
    salt: chosen.salt,
    order: {
      maker: chosen.order.maker,
      traits: chosen.order.traits.toString(),
      data: chosen.order.data,
    },
    shipTx: hash,
  }
  delete deployments.lastFill
  writeDeployments(deployments)
  info('written to      ', 'deployments/sepolia.json')

  // -------------------------------------------------------------------
  step(3, 'leave the taker ready to fill')
  // -------------------------------------------------------------------

  // `isAToB` reads the order's tokens in the sorted order they are stored in, so the taker pays token0.
  const tokenIn = token0
  const symbolIn = await publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'symbol' })

  const [allowance, balance] = await Promise.all([
    publicClient.readContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, router],
    }),
    publicClient.readContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    }),
  ])

  if (allowance === 0n) {
    const approveHash = await wallet.writeContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: 'approve',
      args: [router, 2n ** 256n - 1n],
    })
    await publicClient.waitForTransactionReceipt({ hash: approveHash })
    info('approved        ', `${symbolIn} -> router  ${approveHash}`)
  } else {
    info('approval        ', `${symbolIn} -> router already set`)
  }

  info('taker balance   ', `${formatUnits(balance, 18)} ${symbolIn}`)
  info('gas             ', `${formatUnits(await publicClient.getBalance({ address: account.address }), 18)} ETH`)

  console.log('\nReset. The book quotes a strategy that has never been filled.')
  info('next            ', 'yarn fill')
  console.log()
}

main().catch((error) => {
  console.error(`\n${error}`)
  process.exit(1)
})
