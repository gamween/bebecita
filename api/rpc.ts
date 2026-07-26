/**
 * The JSON-RPC proxy, production half.
 *
 * It forwards to whatever endpoint the deployment is configured with, so a rate limited public node can be
 * swapped for a keyed one without touching the bundle. It reads no state and holds no logic: every number the
 * app shows still comes from the chain, this only decides which door the question goes through.
 */

const PUBLIC_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'JSON-RPC is POST only' }, { status: 405 })
  }

  const upstream = process.env.SEPOLIA_RPC_URL || PUBLIC_SEPOLIA_RPC
  const body = await request.text()

  try {
    const response = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const text = await response.text()
    return new Response(text, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    return Response.json({ error: 'rpc unreachable', detail: String(error) }, { status: 502 })
  }
}

export const config = { runtime: 'edge' }
