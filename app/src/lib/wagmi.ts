import { createConfig, createStorage, injected, type Connector, type CreateConnectorFn } from 'wagmi'
import { coinbaseWallet, walletConnect } from 'wagmi/connectors'

import { CHAIN, POLL_MS, readTransport, rpcEndpoints } from './client'

/**
 * The wallet layer.
 *
 * wagmi owns the connection, the account, the chain and the reconnect. viem stays underneath: every client
 * wagmi hands back is a viem client, and the read transport is the one declared in `client.ts`, so the
 * dashboard and the connected wallet talk to the same endpoints.
 *
 * Three connectors, and the set is decided at load time rather than guessed at:
 *
 * - `injected` covers every extension. `multiInjectedProviderDiscovery` also announces each one separately
 *   through EIP-6963, which is how the chooser can name Rabby or MetaMask instead of saying "browser wallet";
 * - `coinbaseWallet` costs one dependency and needs no configuration, so a judge with no extension installed
 *   still has a way in;
 * - `walletConnect` needs a project id. It is registered when `VITE_WALLETCONNECT_PROJECT_ID` is set and it is
 *   simply absent when it is not, because a WalletConnect button without a project id is a button that opens a
 *   modal and then fails, which is worse than no button at all.
 */

/** Self serve and free at https://cloud.reown.com. Absent is a supported configuration, not an error. */
export const walletConnectProjectId = String(import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '').trim()

const metadata = {
  name: 'Bebecita',
  description: 'An Aqua order book whose maker inventory lives in a Uniswap v4 position',
  url: typeof window === 'undefined' ? 'http://localhost:5173' : window.location.origin,
  icons: [],
}

function connectors(): CreateConnectorFn[] {
  const list: CreateConnectorFn[] = [
    injected({ shimDisconnect: true }),
    coinbaseWallet({ appName: metadata.name }),
  ]
  if (walletConnectProjectId) {
    list.push(
      walletConnect({
        projectId: walletConnectProjectId,
        metadata,
        showQrModal: true,
      }),
    )
  }
  return list
}

export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: connectors(),
  // EIP-6963. Every extension that announces itself becomes its own connector, named and logoed by the
  // extension, which is what makes the chooser readable when several are installed.
  multiInjectedProviderDiscovery: true,
  // Reconnect on reload is wagmi's, and it needs somewhere to remember which connector was authorised.
  storage: createStorage({
    key: 'bebecita.wallet',
    storage: typeof window === 'undefined' ? undefined : window.localStorage,
  }),
  transports: { [CHAIN.id]: readTransport },
  pollingInterval: POLL_MS,
})

/**
 * The connectors worth putting in front of somebody.
 *
 * The generic `injected` connector and the EIP-6963 ones overlap: with an extension installed, both a
 * connector called "Injected" and one called "Rabby" would be offered and they would do the same thing. When
 * a discovered one exists the generic entry is dropped, and when none does it is kept, because that is the
 * only entry that can reach an extension which does not announce itself.
 */
export function offeredConnectors(all: readonly Connector[]): Connector[] {
  const discovered = all.filter((connector) => connector.type === 'injected' && connector.id !== 'injected')
  if (!discovered.length) return [...all]
  return all.filter((connector) => connector.id !== 'injected')
}

/**
 * What `wallet_addEthereumChain` is sent when the wallet has never heard of Sepolia.
 *
 * wagmi's injected connector falls back to this on error 4902, so a wallet with no Sepolia entry is one press
 * away rather than a dead end. The endpoints are this app's own, minus the dev server proxy: that one is only
 * reachable from this origin and a wallet given it would never connect.
 */
export const addSepoliaParameter = {
  chainName: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: rpcEndpoints().filter((url) => /^https?:\/\//.test(url) && !url.includes('/api/rpc')),
  blockExplorerUrls: [CHAIN.blockExplorers.default.url],
}

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
