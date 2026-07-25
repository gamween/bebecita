import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
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

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
