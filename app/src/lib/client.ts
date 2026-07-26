import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import { sepolia } from 'viem/chains'

/**
 * The read side of the app.
 *
 * Sepolia is the only chain that carries both halves of this project, so there is nothing to fall back to and
 * nothing to configure. The wallet side lives in `wagmi.ts` and shares the endpoints declared here, so a read
 * answered for the dashboard and a read answered for the connected wallet come from the same place.
 */

export const CHAIN = sepolia

/**
 * Read endpoints, in order of preference. `VITE_SEPOLIA_RPC_URL` wins if the operator set one. In dev the
 * request goes through the Vite proxy, so a private endpoint stays in the dev server instead of the bundle.
 * The two public endpoints are the honest fallback: this is a testnet demo and they are rate limited.
 */
export function rpcEndpoints(): string[] {
  const endpoints: string[] = []
  const configured = import.meta.env.VITE_SEPOLIA_RPC_URL
  if (configured) endpoints.push(configured)
  if (import.meta.env.DEV) endpoints.push(`${window.location.origin}/api/rpc`)
  endpoints.push('https://ethereum-sepolia-rpc.publicnode.com')
  endpoints.push('https://sepolia.drpc.org')
  return endpoints
}

/** How often anything on a timer is allowed to ask the chain a question. */
export const POLL_MS = 5_000

export const readTransport = fallback(
  rpcEndpoints().map((url) => http(url, { timeout: 15_000 })),
  { retryCount: 1 },
)

export const publicClient: PublicClient = createPublicClient({
  chain: CHAIN,
  transport: readTransport,
  pollingInterval: POLL_MS,
  batch: { multicall: { wait: 24 } },
})
