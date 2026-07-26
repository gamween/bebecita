/**
 * `TakerTraitsLib.build`, ported to TypeScript, byte for byte.
 *
 * The sponsor's builder is `internal pure` Solidity, so it can only be called from a contract or a Foundry
 * script. That is the single reason this project used to ship a local HTTP server: `forge` is not available in
 * a browser, so the encoding had to happen in a process. Porting the twenty lines that matter removes the
 * process, and the fill becomes a thing a wallet does rather than a thing a backend does.
 *
 * The port is not asserted, it is proved. `solver/src/fixtures.ts` writes the output of this function for a
 * set of shapes into `contracts/test/fixtures/taker-traits.json`, and `contracts/test/TakerTraits.t.sol` reads
 * that file, calls the sponsor's own `TakerTraitsLib.build` on the same arguments and asserts byte equality.
 * A one byte error here does not fail to decode, it decodes a different slice: the VM prices against garbage
 * and the revert that surfaces is `TakerTraitsAmountOutMustBeGreaterThanZero`, which points at the amount
 * rather than at the header. That failure mode is why the test exists.
 *
 * The layout, from `node_modules/@1inch/swap-vm/src/libs/TakerTraits.sol`:
 *
 *   [0, 20)   uint160, ten uint16 slice indexes, little end first: index0 at bit 0, index9 at bit 144
 *   [20, 22)  uint16 of flags
 *   [22, ..)  the slices, concatenated in the order the `TakerDataSlices` enum declares them
 *
 * Every index is the *end* offset of its slice inside the tail, which makes each one a running sum of the
 * lengths before it. Slice n starts at index(n-1) and stops at index(n); the first starts at 0 and the last,
 * the signature, runs to the end of the data, which is why there are ten indexes for eleven slices.
 */
import { concatHex, numberToHex, type Address, type Hex } from 'viem'

/**
 * The order the `TakerDataSlices` enum declares, which is the order the tail concatenates in.
 *
 * Documentation, deliberately, and not a lookup: nothing indexes this array, because `build` below writes the
 * slices out positionally and an index computed from a name would be a second encoding of the same order.
 * It is here because the header this file writes is eleven anonymous byte ranges, and the only way to check a
 * slice index by eye against `node_modules/@1inch/swap-vm/src/libs/TakerTraits.sol` is to have the names in
 * the same order next to them. Deleting it as unused would cost exactly that.
 */
export const TAKER_DATA_SLICES = [
  'Threshold',
  'To',
  'Deadline',
  'PreTransferInHook',
  'PostTransferInHook',
  'PreTransferOutHook',
  'PostTransferOutHook',
  'PreTransferInCallback',
  'PreTransferOutCallback',
  'InstructionsArgs',
  'Signature',
] as const

export const IS_EXACT_IN_BIT_FLAG = 0x0001
export const SHOULD_UNWRAP_BIT_FLAG = 0x0002
export const HAS_PRE_TRANSFER_IN_CALLBACK_BIT_FLAG = 0x0004
export const HAS_PRE_TRANSFER_OUT_CALLBACK_BIT_FLAG = 0x0008
export const IS_STRICT_THRESHOLD_BIT_FLAG = 0x0010
export const IS_FIRST_TRANSFER_FROM_TAKER_BIT_FLAG = 0x0020
export const USE_TRANSFER_FROM_AND_AQUA_PUSH_FLAG = 0x0040
export const IS_A_TO_B_BIT_FLAG = 0x0080

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

/** Mirrors `TakerTraitsLib.Args`. Everything but the taker is optional and defaults to the empty case. */
export interface TakerTraitsArgs {
  /** Swap executor. Only read by `build` to decide whether the recipient slice is redundant. */
  taker: Address
  isExactIn?: boolean
  shouldUnwrapWeth?: boolean
  isStrictThresholdAmount?: boolean
  isFirstTransferFromTaker?: boolean
  useTransferFromAndAquaPush?: boolean
  isAToB?: boolean
  /** Min output on exact in, max input on exact out. Exactly 32 bytes, or empty. */
  threshold?: Hex
  /** Recipient. Zero, or the taker itself, encodes no slice at all. */
  to?: Address
  /** Expiration timestamp, five bytes. Zero encodes no slice. */
  deadline?: bigint | number
  hasPreTransferInCallback?: boolean
  hasPreTransferOutCallback?: boolean
  preTransferInHookData?: Hex
  postTransferInHookData?: Hex
  preTransferOutHookData?: Hex
  postTransferOutHookData?: Hex
  preTransferInCallbackData?: Hex
  preTransferOutCallbackData?: Hex
  instructionsArgs?: Hex
  signature?: Hex
}

const EMPTY: Hex = '0x'

/** Length in bytes of a hex blob, with `undefined` and `0x` both reading as empty. */
export function byteLength(data: Hex | undefined): number {
  if (!data || data === EMPTY) return 0
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new Error(`not a byte aligned hex string: ${data}`)
  return (data.length - 2) / 2
}

/**
 * `SafeCast.toUint16`, which is what the sponsor's builder applies to every index from the third onwards.
 *
 * The first three cannot overflow by construction (32 for a threshold, 20 for a recipient, 5 for a deadline),
 * and the library does not cast them. The rest are sums over payloads a taker supplies, so a 65 536 byte hook
 * payload reverts there rather than silently wrapping into the neighbouring index. Same here, with a sentence
 * instead of a panic code.
 */
function toUint16(value: number, slice: string): number {
  if (value > 0xffff) {
    throw new Error(
      `the ${slice} slice ends at byte ${value} and a taker traits index is a uint16, so the tail cannot ` +
        'exceed 65535 bytes. SafeCast.toUint16 reverts on the same input in TakerTraitsLib.build.',
    )
  }
  return value
}

/**
 * The 22 byte header followed by the slices, exactly as `TakerTraitsLib.build` packs them.
 *
 * Every branch below is transcribed from the library rather than reasoned about, including the two that are
 * easy to get wrong: a recipient equal to the taker encodes no slice, because the VM already defaults to the
 * taker, and a zero deadline encodes no slice rather than five zero bytes.
 */
export function buildTakerTraits(args: TakerTraitsArgs): Hex {
  const threshold = args.threshold ?? EMPTY
  const thresholdLength = byteLength(threshold)
  if (thresholdLength !== 32 && thresholdLength !== 0) {
    throw new Error(
      `threshold must be 32 bytes or empty, got ${thresholdLength}. TakerTraitsLib.build reverts with ` +
        'TakerTraitsThresholdLengthInvalid on the same input.',
    )
  }

  const preTransferInCallbackData = args.preTransferInCallbackData ?? EMPTY
  const preTransferOutCallbackData = args.preTransferOutCallbackData ?? EMPTY
  if (byteLength(preTransferInCallbackData) > 0 && !args.hasPreTransferInCallback) {
    throw new Error('preTransferInCallbackData is set but hasPreTransferInCallback is false')
  }
  if (byteLength(preTransferOutCallbackData) > 0 && !args.hasPreTransferOutCallback) {
    throw new Error('preTransferOutCallbackData is set but hasPreTransferOutCallback is false')
  }

  const to = args.to ?? ZERO_ADDRESS
  const deadline = BigInt(args.deadline ?? 0)
  const hasRecipient = to !== ZERO_ADDRESS && to.toLowerCase() !== args.taker.toLowerCase()
  const hasDeadline = deadline !== 0n

  const preTransferInHookData = args.preTransferInHookData ?? EMPTY
  const postTransferInHookData = args.postTransferInHookData ?? EMPTY
  const preTransferOutHookData = args.preTransferOutHookData ?? EMPTY
  const postTransferOutHookData = args.postTransferOutHookData ?? EMPTY
  const instructionsArgs = args.instructionsArgs ?? EMPTY
  const signature = args.signature ?? EMPTY

  const index0 = thresholdLength
  const index1 = index0 + (hasRecipient ? 20 : 0)
  const index2 = index1 + (hasDeadline ? 5 : 0)
  const index3 = toUint16(index2 + byteLength(preTransferInHookData), 'preTransferInHookData')
  const index4 = toUint16(index3 + byteLength(postTransferInHookData), 'postTransferInHookData')
  const index5 = toUint16(index4 + byteLength(preTransferOutHookData), 'preTransferOutHookData')
  const index6 = toUint16(index5 + byteLength(postTransferOutHookData), 'postTransferOutHookData')
  const index7 = toUint16(index6 + byteLength(preTransferInCallbackData), 'preTransferInCallbackData')
  const index8 = toUint16(index7 + byteLength(preTransferOutCallbackData), 'preTransferOutCallbackData')
  const index9 = toUint16(index8 + byteLength(instructionsArgs), 'instructionsArgs')

  const indexes = [index0, index1, index2, index3, index4, index5, index6, index7, index8, index9]
  const slicesIndexes = indexes.reduce((packed, index, position) => packed | (BigInt(index) << BigInt(16 * position)), 0n)

  const flags =
    (args.isExactIn ? IS_EXACT_IN_BIT_FLAG : 0) |
    (args.shouldUnwrapWeth ? SHOULD_UNWRAP_BIT_FLAG : 0) |
    (args.isStrictThresholdAmount ? IS_STRICT_THRESHOLD_BIT_FLAG : 0) |
    (args.isFirstTransferFromTaker ? IS_FIRST_TRANSFER_FROM_TAKER_BIT_FLAG : 0) |
    (args.useTransferFromAndAquaPush ? USE_TRANSFER_FROM_AND_AQUA_PUSH_FLAG : 0) |
    (args.hasPreTransferInCallback ? HAS_PRE_TRANSFER_IN_CALLBACK_BIT_FLAG : 0) |
    (args.hasPreTransferOutCallback ? HAS_PRE_TRANSFER_OUT_CALLBACK_BIT_FLAG : 0) |
    (args.isAToB ? IS_A_TO_B_BIT_FLAG : 0)

  return concatHex([
    numberToHex(slicesIndexes, { size: 20 }),
    numberToHex(flags, { size: 2 }),
    threshold,
    hasRecipient ? to : EMPTY,
    hasDeadline ? numberToHex(deadline, { size: 5 }) : EMPTY,
    preTransferInHookData,
    postTransferInHookData,
    preTransferOutHookData,
    postTransferOutHookData,
    preTransferInCallbackData,
    preTransferOutCallbackData,
    instructionsArgs,
    signature,
  ])
}

/**
 * The header a quote needs, which is the degenerate case of the builder above.
 *
 * No threshold, no recipient, no deadline, no hook data and no instruction arguments, so all ten indexes are
 * zero and the header collapses to twenty zero bytes followed by the flag word. Only `isExactIn` and `isAToB`
 * reach the VM from here, so a quote built this way prices exactly what the fill will execute.
 */
export function buildQuoteTakerTraits(options: { isExactIn: boolean; isAToB: boolean }): Hex {
  return buildTakerTraits({
    taker: ZERO_ADDRESS,
    isExactIn: options.isExactIn,
    isAToB: options.isAToB,
  })
}

/**
 * The one shape this project fills with, and the three flags that carry the whole design.
 *
 * `isFirstTransferFromTaker` stays false. That selects the second transfer ordering in `SwapVM.swap`, which
 * runs `preTransferOut` and the Aqua pull first and `postTransferIn` last. `postTransferIn` is then the only
 * hook that runs after the taker's input has reached the maker, which is what makes a two sided redeposit
 * fundable, which is what keeps the position in range and therefore earning. Flipping this bit moves the
 * redeposit before the money arrives and silently turns a two sided refund into a one sided one.
 *
 * `useTransferFromAndAquaPush` is true, so the router pulls `tokenIn` from the taker and pushes it into Aqua
 * on the taker's behalf. The alternative expects the taker to have pushed beforehand, and the approval would
 * then go somewhere else.
 *
 * `isExactIn` is true: the taker sizes the fill from an input amount and the VM computes the output.
 *
 * The unwind goes in `preTransferOutHookData` because `preTransferOut` is the only point in SwapVM guaranteed
 * to run immediately before tokens leave the maker, and the redeposit goes in `postTransferInHookData` for
 * the ordering reason above. Both are executed by `BebecitaVault`, which pins the callee and the selector and
 * then judges them by their effects.
 */
export function buildFillTakerTraits(params: {
  taker: Address
  /** Slippage floor, `abi.encodePacked(uint256)`, so exactly 32 bytes. */
  amountOutMin: bigint
  decreaseCalldata: Hex
  increaseCalldata: Hex
  isAToB?: boolean
}): Hex {
  return buildTakerTraits({
    taker: params.taker,
    isExactIn: true,
    shouldUnwrapWeth: false,
    isStrictThresholdAmount: false,
    isFirstTransferFromTaker: false,
    useTransferFromAndAquaPush: true,
    isAToB: params.isAToB ?? true,
    threshold: numberToHex(params.amountOutMin, { size: 32 }),
    to: ZERO_ADDRESS,
    deadline: 0,
    hasPreTransferInCallback: false,
    hasPreTransferOutCallback: false,
    preTransferInHookData: EMPTY,
    postTransferInHookData: params.increaseCalldata,
    preTransferOutHookData: params.decreaseCalldata,
    postTransferOutHookData: EMPTY,
    preTransferInCallbackData: EMPTY,
    preTransferOutCallbackData: EMPTY,
    instructionsArgs: EMPTY,
    signature: EMPTY,
  })
}
