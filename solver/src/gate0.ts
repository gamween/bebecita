/**
 * Gate zero. The six checks that decide whether this project exists, in under two minutes.
 *
 * Nothing else gets written until this passes. Run with `yarn gate0`.
 */
import { createPublicClient, http, getAddress } from 'viem'
import { sepolia } from 'viem/chains'
import { SEPOLIA, env } from './config.js'
import { UniswapClient } from './uniswap.js'

const ok = (label: string, detail = '') => console.log(`  PASS  ${label}${detail ? `  ${detail}` : ''}`)
const bad = (label: string, detail = '') => console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ''}`)

async function main() {
  let failures = 0
  const client = createPublicClient({ chain: sepolia, transport: http(env.rpcUrl) })

  console.log('\nGate zero, Ethereum Sepolia\n')

  // 1. The official Aqua is really there.
  const aquaCode = await client.getCode({ address: getAddress(SEPOLIA.aqua) })
  aquaCode && aquaCode.length > 2
    ? ok('official Aqua has code', `${aquaCode.length} chars`)
    : (bad('official Aqua has no code'), failures++)

  // 2. So is the Uniswap v4 PositionManager.
  const posmCode = await client.getCode({ address: getAddress(SEPOLIA.positionManager) })
  posmCode && posmCode.length > 2
    ? ok('v4 PositionManager has code')
    : (bad('v4 PositionManager has no code'), failures++)

  // 3. And it answers the read the instruction depends on.
  try {
    const liquidity = await client.readContract({
      address: getAddress(SEPOLIA.positionManager),
      abi: [
        {
          type: 'function',
          name: 'getPositionLiquidity',
          stateMutability: 'view',
          inputs: [{ name: 'tokenId', type: 'uint256' }],
          outputs: [{ name: '', type: 'uint128' }],
        },
      ],
      functionName: 'getPositionLiquidity',
      args: [1n],
    })
    ok('getPositionLiquidity answers', `tokenId 1 -> ${liquidity}`)
  } catch (error) {
    bad('getPositionLiquidity failed', String(error).slice(0, 120))
    failures++
  }

  // 4. The API key is live on the trade host.
  const uniswap = new UniswapClient({ apiKey: env.apiKey, chainId: SEPOLIA.chainId, protocol: 'V4' })
  try {
    await uniswap.supportedChains()
    ok('Uniswap API key accepted', `quota left ${uniswap.remainingQuota ?? 'n/a'}`)
  } catch (error) {
    bad('Uniswap API key rejected', String(error).slice(0, 200))
    failures++
  }

  // 5. And on the LP host, which is a different origin and the one that actually matters here.
  //    The seven /lp/* paths carry a per-path server override to liquidity.api.uniswap.org.
  try {
    await uniswap.poolInfo({
      tokenA: '0x0000000000000000000000000000000000000000',
      tokenB: SEPOLIA.weth,
      fee: 3000,
      tickSpacing: 60,
    })
    ok('LP host reachable and authenticated', 'liquidity.api.uniswap.org')
  } catch (error) {
    bad('LP host rejected the call', String(error).slice(0, 200))
    failures++
  }

  // 6. The deployer can pay for gas.
  try {
    const { privateKeyToAccount } = await import('viem/accounts')
    const account = privateKeyToAccount(env.privateKey as `0x${string}`)
    const balance = await client.getBalance({ address: account.address })
    balance > 0n
      ? ok('deployer funded', `${account.address} ${balance} wei`)
      : (bad('deployer has no Sepolia ETH', account.address), failures++)
  } catch (error) {
    bad('deployer key unusable', String(error).slice(0, 120))
    failures++
  }

  console.log(failures === 0 ? '\nGate zero green. Start building.\n' : `\n${failures} check(s) failed.\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
