import 'dotenv/config'

/**
 * Ethereum Sepolia is the only chain outside mainnet that carries both halves of this project.
 *
 * The official Aqua is deployed there at its canonical address, with bytecode byte for byte identical to the
 * Base deployment (sha256 e30d2eab49ae15c876b4d75131185c78bb28e88ac8a21faab06336139b84a1af on both), and the
 * Uniswap API accepts chainId 11155111. Base Sepolia and Unichain Sepolia carry no Aqua at all. That was
 * established by probing the chains, not by reading a deployment table: no 1inch README lists a testnet.
 */
export const SEPOLIA = {
  chainId: 11155111,

  /** Official Aqua, same address as every mainnet deployment. */
  aqua: '0x499943E74FB0cE105688beeE8Ef2ABec5D936d31',
  /** Official AquaSwapVMRouter, used as the red side of the split screen comparison. */
  officialRouter: '0x8fdd04dbf6111437b44bbca99c28882434e0958f',

  /** Uniswap v4, verified against developers.uniswap.org/docs/protocols/v4/deployments. */
  poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
  positionManager: '0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4',
  stateView: '0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c',
  v4Quoter: '0x61b3f2011a92d183c7dbadbda940a7555ccf9227',
  universalRouter: '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',

  /** Only a constructor argument for the router. The demo pair is our own ERC20s. */
  weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
} as const

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name} in .env, see .env.example`)
  return value
}

export const env = {
  get apiKey() {
    return required('UNISWAP_API_KEY')
  },
  /**
   * `||` and not `??` on purpose. `.env.example` ships `SEPOLIA_RPC_URL=` with nothing after it, so the
   * variable is present and empty rather than absent. viem hides that by falling back to the chain default
   * when handed an empty string, and `forge script --rpc-url ''` fails with a transport error naming the
   * working directory, which is a long way from the cause.
   */
  get rpcUrl() {
    return process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
  },
  get privateKey() {
    return required('DEPLOYER_PRIVATE_KEY')
  },
}
