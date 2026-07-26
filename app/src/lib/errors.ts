import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem'

/**
 * A sentence a human can act on, out of whatever the wallet, the node or the VM threw.
 *
 * viem stacks its errors, so the useful part is never the outermost one: a reverted fill arrives as a
 * `ContractFunctionExecutionError` wrapping a `ContractFunctionRevertedError` carrying the decoded custom
 * error, and printing the outer one gives a paragraph of ABI and calldata instead of the name of the guard
 * that fired. This walks down to the part that says something and formats that.
 */

type Walkable = { walk: (fn: (error: unknown) => boolean) => unknown }

function walk(error: unknown, matches: (candidate: unknown) => boolean): unknown {
  if (error && typeof (error as Walkable).walk === 'function') {
    return (error as Walkable).walk(matches)
  }
  let current: unknown = error
  for (let depth = 0; current && depth < 12; depth += 1) {
    if (matches(current)) return current
    current = (current as { cause?: unknown }).cause
  }
  return null
}

/** EIP-1193 rejection, which every wallet reports the same way and no wallet reports as a viem error. */
function isRejection(error: unknown): boolean {
  if (error instanceof UserRejectedRequestError) return true
  const code = (error as { code?: unknown } | null)?.code
  return code === 4001 || code === 'ACTION_REJECTED'
}

function formatRevert(error: ContractFunctionRevertedError): string {
  const name = error.data?.errorName
  if (name) {
    const args = error.data?.args ?? []
    const printed = args.map((value) => (typeof value === 'bigint' ? value.toString() : String(value)))
    return args.length ? `reverted with ${name}(${printed.join(', ')})` : `reverted with ${name}`
  }
  if (error.reason) return `reverted: ${error.reason}`
  if (error.signature) return `reverted with an error this app cannot decode, selector ${error.signature}`
  return error.shortMessage
}

export function describeError(error: unknown): string {
  if (walk(error, isRejection) || isRejection(error)) {
    return 'the request was rejected in the wallet, nothing was sent'
  }

  const reverted = walk(error, (candidate) => candidate instanceof ContractFunctionRevertedError)
  if (reverted instanceof ContractFunctionRevertedError) return formatRevert(reverted)

  if (error instanceof BaseError) {
    const detail = error.details?.trim()
    const short = error.shortMessage?.trim()
    if (short && detail && detail !== short) return `${short} ${detail}`
    if (short) return short
  }

  const shortMessage = (error as { shortMessage?: string } | null)?.shortMessage
  if (typeof shortMessage === 'string' && shortMessage.trim()) return shortMessage.trim()

  if (error instanceof Error) return error.message.split('\n')[0]
  return String(error)
}
