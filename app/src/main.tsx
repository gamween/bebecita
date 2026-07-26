import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider } from 'wagmi'

import { App } from './App'
import { wagmiConfig } from './lib/wagmi'
import './styles.css'

/**
 * Every number on this page is a bigint, and React's development build logs each render by serialising the
 * props it changed with `JSON.stringify`, which throws `Do not know how to serialize a BigInt`. The throw
 * happens inside React's own effect commit, which leaves its scheduler in the "Should not already be working"
 * state and stops the page reacting to clicks at all. One shim on the prototype is the whole fix, and it also
 * makes any future JSON.stringify of a snapshot behave instead of exploding.
 */
;(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function toJSON(this: bigint) {
  return this.toString()
}

const container = document.getElementById('root')
if (!container) throw new Error('missing #root')

/**
 * wagmi keeps its own reads in react-query, which is where the block number in the top bar lives. The chain
 * reads this app does itself stay on their own timers in the dashboard, so nothing here refetches on a
 * window focus and no cache decides when the Uniswap API is called.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})

createRoot(container).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
