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
 * Read endpoints, in order of preference. `VITE_SEPOLIA_RPC_URL` wins if the operator set one.
 *
 * `/api/rpc` comes next in both dev and production, and it is the same proxy in either place: the Vite dev
 * server locally, an edge function on the deployment. It exists so a keyed endpoint can be configured server
 * side, through `SEPOLIA_RPC_URL`, without that endpoint ever reaching the bundle. It is a same origin URL,
 * so it is only reachable when the app is actually served, which is why the two public endpoints stay behind
 * it as the honest fallback: this is a testnet demo and they are rate limited.
 */
export function rpcEndpoints(): string[] {
  const endpoints: string[] = []
  const configured = import.meta.env.VITE_SEPOLIA_RPC_URL
  if (configured) endpoints.push(configured)
  if (typeof window !== 'undefined') endpoints.push(`${window.location.origin}/api/rpc`)
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
