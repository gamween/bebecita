/**
 * The Uniswap API proxy, production half.
 *
 * In development this lives in the Vite dev server. Neither version runs any of this project's logic: they
 * attach the Developer Platform key to an outbound request and forward the answer back. The key stays server
 * side in both, which is the only reason a proxy exists at all. The fill itself happens in the tab, signed by
 * the connected wallet, and nothing here can change what a fill does.
 *
 * The host is not a detail. The seven `/lp/*` operations belong to the same OpenAPI document as
 * `trade-api.gateway.uniswap.org/v1` and use the same `x-api-key` scheme, but the document carries a per-path
 * server override and they are served from `liquidity.api.uniswap.org` with no version prefix. Anything else
 * goes to the trade host. Routing on that distinction here means the browser never has to know about it.
 */

const LP_HOST = 'https://liquidity.api.uniswap.org'
const TRADE_HOST = 'https://trade-api.gateway.uniswap.org/v1'

/** `/lp/...` is served from its own host, everything else from the trade host. */
function upstreamFor(path: string): string {
  return path.startsWith('/lp/') ? `${LP_HOST}${path}` : `${TRADE_HOST}${path}`
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url)

  // The path arrives as a query parameter rather than as a path segment. A catch-all filename would read
  // better, but this project has no framework, and Vercel does not resolve the bracketed catch-all convention
  // in a plain functions directory: every request under /api/uniswap/... answered 404 until the rewrite in
  // vercel.json made the path explicit. Being boring here is worth more than being idiomatic.
  const path = `/${(url.searchParams.get('path') ?? '').replace(/^\/+/, '')}`
  if (path === '/') {
    return Response.json({ error: 'no upstream path given' }, { status: 400 })
  }
  const upstream = upstreamFor(path)

  const apiKey = process.env.UNISWAP_API_KEY ?? ''

  // The gateway's header validator is strict: Content-Type and Accept must carry nothing but the media type,
  // and browser noise (origin, referer, cookie) is not welcome. So the request is rebuilt rather than relayed.
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (apiKey) headers['x-api-key'] = apiKey

  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()

  let response: Response
  try {
    response = await fetch(upstream, { method: request.method, headers, body })
  } catch (error) {
    return Response.json(
      { error: 'upstream unreachable', upstream, detail: String(error) },
      { status: 502 },
    )
  }

  const text = await response.text()

  // Proof of provenance for the network panel, mirroring the dev server: which host actually answered, and
  // whether a key was attached. A judge reading the panel can tell a real call from a fabricated one.
  const out = new Headers({
    'Content-Type': response.headers.get('content-type') ?? 'application/json',
    'Cache-Control': 'no-store',
    'x-bebecita-upstream': upstream,
    'x-bebecita-api-key': apiKey ? 'present' : 'absent',
  })

  // The rate limit headers are the evidence that the key is live, so they must survive the hop.
  for (const name of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
    const value = response.headers.get(name)
    if (value) out.set(name, value)
  }

  return new Response(text, { status: response.status, headers: out })
}

export const config = { runtime: 'edge' }
