import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  http,
  type Address,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { sepolia } from 'viem/chains'

export const CHAIN = sepolia
export const CHAIN_ID_HEX = `0x${sepolia.id.toString(16)}` as const

/**
 * Read endpoints, in order of preference. `VITE_SEPOLIA_RPC_URL` wins if the operator set one. In dev the
 * request goes through the Vite proxy, so a private endpoint stays in the dev server instead of the bundle.
 * The two public endpoints are the honest fallback: this is a testnet demo and they are rate limited.
 */
function rpcEndpoints(): string[] {
  const endpoints: string[] = []
  const configured = import.meta.env.VITE_SEPOLIA_RPC_URL
  if (configured) endpoints.push(configured)
  if (import.meta.env.DEV) endpoints.push(`${window.location.origin}/api/rpc`)
  endpoints.push('https://ethereum-sepolia-rpc.publicnode.com')
  endpoints.push('https://sepolia.drpc.org')
  return endpoints
}

export const publicClient: PublicClient = createPublicClient({
  chain: CHAIN,
  transport: fallback(
    rpcEndpoints().map((url) => http(url, { timeout: 15_000 })),
    { retryCount: 1 },
  ),
  batch: { multicall: { wait: 24 } },
})

export function getProvider(): EIP1193Provider | null {
  const injected = (window as unknown as { ethereum?: EIP1193Provider }).ethereum
  return injected ?? null
}

export interface WalletState {
  address: Address
  chainId: number
}

function parseChainId(value: unknown): number {
  return typeof value === 'string' ? Number.parseInt(value, 16) : Number(value)
}

/** Reconnects silently if the wallet already granted this origin an account. */
export async function readWallet(): Promise<WalletState | null> {
  const provider = getProvider()
  if (!provider) return null
  const accounts = (await provider.request({ method: 'eth_accounts' })) as Address[]
  if (!accounts?.length) return null
  const chainId = parseChainId(await provider.request({ method: 'eth_chainId' }))
  return { address: accounts[0], chainId }
}

export async function connectWallet(): Promise<WalletState> {
  const provider = getProvider()
  if (!provider) throw new Error('no injected wallet found on window.ethereum')
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as Address[]
  if (!accounts?.length) throw new Error('the wallet returned no account')
  const chainId = parseChainId(await provider.request({ method: 'eth_chainId' }))
  return { address: accounts[0], chainId }
}

/** Sepolia is the only chain that carries both halves of this project, so there is nothing to fall back to. */
export async function switchToSepolia(): Promise<void> {
  const provider = getProvider()
  if (!provider) throw new Error('no injected wallet found on window.ethereum')
  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: CHAIN_ID_HEX }],
  })
}

export function walletClientFor(address: Address): WalletClient {
  const provider = getProvider()
  if (!provider) throw new Error('no injected wallet found on window.ethereum')
  return createWalletClient({ account: address, chain: CHAIN, transport: custom(provider) })
}

export function onWalletEvent(handler: () => void): () => void {
  const provider = getProvider() as (EIP1193Provider & { removeListener?: (e: string, h: () => void) => void }) | null
  if (!provider?.on) return () => {}
  provider.on('accountsChanged', handler)
  provider.on('chainChanged', handler)
  return () => {
    provider.removeListener?.('accountsChanged', handler)
    provider.removeListener?.('chainChanged', handler)
  }
}
