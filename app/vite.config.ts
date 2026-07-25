import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/** The two files that own the addresses. The frontend keeps no second copy of any of them. */
const DEPLOYMENTS_JSON = resolve(repoRoot, 'deployments/sepolia.json')
const SOLVER_CONFIG_TS = resolve(repoRoot, 'solver/src/config.ts')

/** Served path of the deployment record, read at runtime so a redeploy needs no rebuild. */
const DEPLOYMENTS_ROUTE = '/deployments/sepolia.json'
/** Served path of the fixed Sepolia addresses extracted from the solver config. */
const CHAIN_ROUTE = '/deployments/chain.json'

const LP_HOST = 'https://liquidity.api.uniswap.org'
const PUBLIC_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'

/**
 * The fixed Sepolia addresses live in `solver/src/config.ts`, which cannot be imported from a browser bundle
 * because it pulls in dotenv. They are lifted out of the source literal instead, so there is exactly one copy
 * of every address in the repository. A parse failure yields an empty record and the app reports the values as
 * unavailable rather than inventing them.
 */
function readSolverChainConfig(): Record<string, string | number> {
  try {
    const source = readFileSync(SOLVER_CONFIG_TS, 'utf8')
    const start = source.indexOf('export const SEPOLIA')
    const end = source.indexOf('} as const', start)
    if (start < 0 || end < 0) return {}
    const block = source.slice(start, end)
    const out: Record<string, string | number> = {}
    const chainId = block.match(/chainId:\s*(\d+)/)
    if (chainId) out.chainId = Number(chainId[1])
    for (const [, key, address] of block.matchAll(/(\w+):\s*'(0x[0-9a-fA-F]{40})'/g)) out[key] = address
    return out
  } catch {
    return {}
  }
}

function readDeployments(): string {
  if (!existsSync(DEPLOYMENTS_JSON)) return '{}'
  return readFileSync(DEPLOYMENTS_JSON, 'utf8')
}

/**
 * Serves the canonical address files in dev and in preview, and copies them into `dist` at build time. Reading
 * them per request matters while the position is being created in another branch: the dashboard picks up a new
 * tokenId on a refresh instead of on a rebuild.
 */
function addressFiles(): Plugin {
  const json = (body: string) => (_req: unknown, res: any) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(body)
  }
  const attach = (server: { middlewares: { use: (route: string, fn: any) => void } }) => {
    server.middlewares.use(DEPLOYMENTS_ROUTE, (req: unknown, res: any) => json(readDeployments())(req, res))
    server.middlewares.use(CHAIN_ROUTE, (req: unknown, res: any) =>
      json(JSON.stringify(readSolverChainConfig(), null, 2))(req, res),
    )
  }
  return {
    name: 'bebecita-address-files',
    configureServer: attach,
    configurePreviewServer: attach,
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'deployments/sepolia.json', source: readDeployments() })
      this.emitFile({
        type: 'asset',
        fileName: 'deployments/chain.json',
        source: JSON.stringify(readSolverChainConfig(), null, 2),
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Loaded from the repository root so the frontend shares the one .env the rest of the project uses. The
  // Uniswap key stays in the dev server: it is injected into the proxied request and never reaches the bundle.
  const env = loadEnv(mode, repoRoot, '')
  const apiKey = env.UNISWAP_API_KEY ?? ''
  const rpcUrl = env.SEPOLIA_RPC_URL || PUBLIC_SEPOLIA_RPC

  const uniswapProxy = {
    target: LP_HOST,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/uniswap/, ''),
    configure: (proxy: any) => {
      proxy.on('proxyReq', (proxyReq: any) => {
        if (apiKey) proxyReq.setHeader('x-api-key', apiKey)
        // The gateway's header validator is strict, and browser noise is not welcome.
        proxyReq.removeHeader('origin')
        proxyReq.removeHeader('referer')
        proxyReq.removeHeader('cookie')
      })
      proxy.on('proxyRes', (proxyRes: any, req: any, res: any) => {
        // Proof of provenance for the network panel: the real upstream and whether a key was attached.
        res.setHeader('x-bebecita-upstream', LP_HOST + String(req.url ?? '').replace(/^\/api\/uniswap/, ''))
        res.setHeader('x-bebecita-api-key', apiKey ? 'present' : 'absent')
        void proxyRes
      })
    },
  }

  const rpcProxy = {
    target: rpcUrl,
    changeOrigin: true,
    rewrite: () => '',
  }

  const proxy = { '/api/uniswap': uniswapProxy, '/api/rpc': rpcProxy }

  return {
    plugins: [react(), addressFiles()],
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
    build: { target: 'es2022', sourcemap: true },
  }
})
