/**
 * Setup. Creates the pool, opens the position, and hands it to the maker.
 *
 * Run with `yarn setup`. Everything happens on public Ethereum Sepolia, against the live Uniswap API: the API
 * derives position state server side from the chain, so a fork is invisible to it and its calldata goes stale.
 *
 * The order of the five steps is not arbitrary.
 *
 *   1. `/lp/check_approval` for the deployer, and execute what comes back. With
 *      `generatePermitAsTransaction: true` the permits arrive as transactions, so nothing here needs a
 *      typed data signature.
 *   2. `/lp/create` with a `newPool` block, and execute it. The pool and the position are born in one
 *      transaction and the demo owns both, which is what makes it replayable.
 *   3. Redeploy the vault against the tokenId that now exists. `BebecitaVault.TOKEN_ID` is immutable and the
 *      first deployment predated the position, so it was constructed with 0.
 *   4. Move the ERC721 to the vault. The vault implements `onERC721Received`.
 *   5. `/lp/check_approval` for the vault, and replay the result through the vault's own entry points, which
 *      is the only way a contract that cannot sign gets a Permit2 allowance.
 *
 * Why not mint straight to the vault. The API accepts a contract as `walletAddress` without complaint and
 * builds the same transaction with the vault as recipient, but that transaction is a `multicall(bytes[])` on
 * the PositionManager, and the vault only forwards `modifyLiquidities`. Executing it would mean splitting the
 * multicall by hand and, worse, deploying the vault against a tokenId read from `nextTokenId()` before the
 * mint, which is a race with every other position minted on Sepolia in between. Minting to the deployer and
 * transferring the NFT afterwards costs one extra transaction and is exact.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toEventSelector,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import { SEPOLIA, env } from './config.js'
import { UniswapClient, type TransactionRequest } from './uniswap.js'

const ROOT = resolve(import.meta.dirname, '../..')
const DEPLOYMENTS = resolve(ROOT, 'deployments/sepolia.json')

/** 0.30% and its canonical spacing. Nothing about the demo depends on the tier, only on it being ours. */
const FEE = 3000
const TICK_SPACING = 60

/**
 * Full range, which is a deliberate choice and not laziness.
 *
 * At full range a unit of v4 liquidity is worth one unit of each token to within rounding, so the maker's
 * `unitsPerLiquidityE18` of 1e18 is an honest conversion factor rather than a tuned one, and the position can
 * never fall out of range and stop being reachable mid demo. `-887220` and `887220` are the extreme ticks
 * rounded to a multiple of 60.
 */
const TICK_LOWER = -887220
const TICK_UPPER = 887220

/** sqrtPriceX96 for a price of 1, which is what two freshly minted 18 decimal tokens are worth to each other. */
const INITIAL_SQRT_PRICE_X96 = (2n ** 96n).toString()

/** Deposited per side. The deployer holds 1,000,000 of each, so this leaves plenty for takers. */
const DEPOSIT = 100_000n * 10n ** 18n

/** ERC721 and ERC20 share this topic0. Only the topic count tells them apart. */
const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)')

const posmAbi = parseAbi([
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function nextTokenId() view returns (uint256)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
])

const vaultAbi = parseAbi([
  'function approve(address token, address spender, uint256 amount)',
  'function approveViaPermit2(address permit2, address token, address spender, uint160 amount, uint48 expiration)',
  'function TOKEN_ID() view returns (uint256)',
  'function OWNER() view returns (address)',
])

const erc20ApproveAbi = parseAbi(['function approve(address spender, uint256 amount)'])
const permit2ApproveAbi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
])

interface Deployments {
  chainId: number
  aqua: string
  positionManager: string
  router: string
  vault: string
  tokenA: string
  tokenB: string
  deployer: string
  permit2?: string
  pool?: Record<string, unknown>
  position?: Record<string, unknown>
  [k: string]: unknown
}

const readDeployments = (): Deployments => JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'))
const writeDeployments = (next: Deployments) => writeFileSync(DEPLOYMENTS, `${JSON.stringify(next, null, 2)}\n`)

const step = (n: number, label: string) => console.log(`\n[${n}] ${label}`)
const info = (label: string, value: unknown = '') => console.log(`    ${label}${value === '' ? '' : `  ${value}`}`)

async function main() {
  const recreate = process.argv.includes('--recreate')
  const skipRedeploy = process.argv.includes('--no-redeploy')

  const deployments = readDeployments()
  const account = privateKeyToAccount(env.privateKey as Hex)
  const publicClient = createPublicClient({ chain: sepolia, transport: http(env.rpcUrl) })
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(env.rpcUrl) })
  const uniswap = new UniswapClient({ apiKey: env.apiKey, chainId: SEPOLIA.chainId, protocol: 'V4' })

  if (getAddress(deployments.deployer) !== account.address) {
    throw new Error(`DEPLOYER_PRIVATE_KEY is ${account.address}, deployments say ${deployments.deployer}`)
  }

  const tokenA = getAddress(deployments.tokenA)
  const tokenB = getAddress(deployments.tokenB)
  const [token0, token1] = tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA]
  const positionManager = getAddress(deployments.positionManager)

  console.log('\nBebecita setup, Ethereum Sepolia')
  info('deployer        ', account.address)
  info('token0          ', token0)
  info('token1          ', token1)

  /** Simulates, signs, broadcasts, waits, and refuses to continue on a reverted receipt. */
  const send = async (label: string, tx: TransactionRequest) => {
    // A failing eth_call carries the revert reason. A failing broadcast carries a receipt and a gas bill.
    await publicClient.call({
      account: account.address,
      to: getAddress(tx.to) as Address,
      data: tx.data as Hex,
      value: tx.value ? BigInt(tx.value) : 0n,
    })

    const hash = await wallet.sendTransaction({
      to: getAddress(tx.to) as Address,
      data: tx.data as Hex,
      value: tx.value ? BigInt(tx.value) : 0n,
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${label} reverted, ${hash}`)
    info(`${label} ok`, `${hash}  gas ${receipt.gasUsed}`)
    return receipt
  }

  // -------------------------------------------------------------------
  step(1, 'POST /lp/check_approval for the deployer, generatePermitAsTransaction')
  // -------------------------------------------------------------------

  const approvals = await uniswap.checkApproval({
    walletAddress: account.address,
    token0,
    token1,
    amount0: DEPOSIT.toString(),
    amount1: DEPOSIT.toString(),
    action: 'CREATE',
  })

  info('transactions returned', approvals.transactions.length)
  for (const [index, item] of approvals.transactions.entries()) {
    const target = getAddress(item.transaction.to)
    const kind = target === getAddress(SEPOLIA.permit2) ? 'permit2 approve' : 'erc20 approve'
    await send(`  ${index + 1}/${approvals.transactions.length} ${kind}`, item.transaction)
  }

  // -------------------------------------------------------------------
  step(2, 'POST /lp/create with a newPool block, then execute it')
  // -------------------------------------------------------------------

  let tokenId = BigInt((deployments.position as { tokenId?: string })?.tokenId ?? 0)

  if (tokenId !== 0n && !recreate) {
    info('position already recorded, reusing', tokenId)
    info('pass --recreate to open a second one')
  } else {
    const created = await uniswap.createPosition({
      walletAddress: account.address,
      token0,
      token1,
      fee: FEE,
      tickSpacing: TICK_SPACING,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      independentToken: token0,
      independentAmount: DEPOSIT.toString(),
      initialPrice: INITIAL_SQRT_PRICE_X96,
    })

    info('token0 in       ', created.token0.amount)
    info('token1 in       ', created.token1.amount)
    info('ticks           ', `${created.tickLower} .. ${created.tickUpper}`)
    info('target          ', created.create.to)

    const receipt = await send('create', created.create)

    // The mint shows up as an ERC721 Transfer out of the zero address on the PositionManager. ERC20 transfers
    // share the topic0, so the four topic form is what separates them.
    const minted = receipt.logs.find(
      (log) =>
        getAddress(log.address) === positionManager &&
        log.topics.length === 4 &&
        log.topics[0] === TRANSFER_TOPIC &&
        BigInt(log.topics[1] as Hex) === 0n,
    )
    if (!minted) throw new Error('no ERC721 mint in the create receipt, cannot learn the tokenId')

    tokenId = BigInt(minted.topics[3] as Hex)
    info('tokenId         ', tokenId)
  }

  const liquidity = await publicClient.readContract({
    address: positionManager,
    abi: posmAbi,
    functionName: 'getPositionLiquidity',
    args: [tokenId],
  })
  if (liquidity === 0n) throw new Error(`position ${tokenId} carries no liquidity`)
  info('liquidity       ', liquidity)

  const poolKey = {
    currency0: token0,
    currency1: token1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: '0x0000000000000000000000000000000000000000' as Address,
  }
  const poolId = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
    ),
  )
  info('poolId          ', poolId)

  deployments.pool = { ...poolKey, poolId, tickLower: TICK_LOWER, tickUpper: TICK_UPPER }
  deployments.position = { tokenId: tokenId.toString(), liquidity: liquidity.toString(), owner: account.address }
  deployments.permit2 = SEPOLIA.permit2
  writeDeployments(deployments)

  // -------------------------------------------------------------------
  step(3, 'redeploy the vault against the real tokenId')
  // -------------------------------------------------------------------

  let vault = getAddress(deployments.vault)
  const currentTokenId = await publicClient
    .readContract({ address: vault, abi: vaultAbi, functionName: 'TOKEN_ID' })
    .catch(() => -1n)

  if (skipRedeploy) {
    info('skipped by --no-redeploy, vault still points at tokenId', currentTokenId)
  } else if (currentTokenId === tokenId) {
    info('vault already points at this position', vault)
  } else {
    info('current vault points at tokenId', currentTokenId)
    vault = deployVault({ tokenId, router: getAddress(deployments.router), tokenA, tokenB })
    info('new vault       ', vault)

    deployments.vault = vault
    writeDeployments(deployments)
  }

  // -------------------------------------------------------------------
  step(4, 'transfer the position to the vault')
  // -------------------------------------------------------------------

  const owner = await publicClient.readContract({
    address: positionManager,
    abi: posmAbi,
    functionName: 'ownerOf',
    args: [tokenId],
  })

  if (getAddress(owner) === vault) {
    info('already owned by the vault', vault)
  } else if (getAddress(owner) !== account.address) {
    throw new Error(`position ${tokenId} is owned by ${owner}, not by the deployer`)
  } else {
    const hash = await wallet.writeContract({
      address: positionManager,
      abi: posmAbi,
      functionName: 'safeTransferFrom',
      args: [account.address, vault, tokenId],
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`safeTransferFrom reverted, ${hash}`)
    info('transferred     ', `${hash}  gas ${receipt.gasUsed}`)
  }

  deployments.position = { ...(deployments.position as object), owner: vault }
  writeDeployments(deployments)

  // -------------------------------------------------------------------
  step(5, 'POST /lp/check_approval for the vault, replayed through the vault')
  // -------------------------------------------------------------------

  // The API returns transactions the vault cannot broadcast, because a contract has no key. It can execute
  // them, which is the whole reason `generatePermitAsTransaction` matters here: each returned call is decoded
  // and re-issued through the vault's own owner-only entry point for that exact selector.
  //
  // An empty list is the good outcome and not a skipped step: the redeploy already granted both halves, so
  // this is the API confirming that a contract owned position is fully approved to add liquidity.
  const vaultApprovals = await uniswap.checkApproval({
    walletAddress: vault,
    token0,
    token1,
    amount0: DEPOSIT.toString(),
    amount1: DEPOSIT.toString(),
    action: 'INCREASE',
  })

  info('transactions returned', vaultApprovals.transactions.length)
  if (vaultApprovals.transactions.length === 0) info('the API considers the vault fully approved')

  for (const item of vaultApprovals.transactions) {
    const target = getAddress(item.transaction.to)
    const data = item.transaction.data as Hex

    if (target === getAddress(SEPOLIA.permit2)) {
      const { args } = decodeFunctionData({ abi: permit2ApproveAbi, data })
      const [token, spender, amount, expiration] = args as [Address, Address, bigint, number]
      const hash = await wallet.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: 'approveViaPermit2',
        args: [getAddress(SEPOLIA.permit2), token, spender, amount, expiration],
      })
      await publicClient.waitForTransactionReceipt({ hash })
      info('permit2 allowance', `${token} -> ${spender}  ${hash}`)
    } else {
      const { args } = decodeFunctionData({ abi: erc20ApproveAbi, data })
      const [spender, amount] = args as [Address, bigint]
      const hash = await wallet.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: 'approve',
        args: [target, spender, amount],
      })
      await publicClient.waitForTransactionReceipt({ hash })
      info('erc20 allowance ', `${target} -> ${spender}  ${hash}`)
    }
  }

  console.log('\nDone.')
  info('vault           ', vault)
  info('tokenId         ', tokenId)
  info('poolId          ', poolId)
  info('written to      ', 'deployments/sepolia.json')
  console.log('\nNext: yarn aqua, which opens the strategy the book quotes.\n')
}

/**
 * Runs `contracts/script/DeployVault.s.sol` and reads the address back out of the broadcast log.
 *
 * `--skip test` matters: `via_ir` makes a full build cost close to four minutes, and the test suite is not
 * needed to deploy one contract.
 */
function deployVault(params: { tokenId: bigint; router: Address; tokenA: Address; tokenB: Address }): Address {
  const args = [
    'script',
    'contracts/script/DeployVault.s.sol',
    '--rpc-url',
    env.rpcUrl,
    '--broadcast',
    '--skip',
    'test',
  ]
  if (process.env.ETHERSCAN_API_KEY) args.push('--verify')

  execFileSync('forge', args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      POSITION_TOKEN_ID: params.tokenId.toString(),
      ROUTER: params.router,
      TOKEN_A: params.tokenA,
      TOKEN_B: params.tokenB,
    },
  })

  const run = JSON.parse(
    readFileSync(resolve(ROOT, `broadcast/DeployVault.s.sol/${SEPOLIA.chainId}/run-latest.json`), 'utf8'),
  ) as { transactions: { transactionType: string; contractName?: string; contractAddress?: string }[] }

  const created = run.transactions.find(
    (tx) => tx.transactionType === 'CREATE' && tx.contractName === 'BebecitaVault',
  )
  if (!created?.contractAddress) throw new Error('DeployVault ran but no BebecitaVault CREATE in the broadcast')
  return getAddress(created.contractAddress)
}

main().catch((error) => {
  console.error(`\n${error}`)
  process.exit(1)
})
