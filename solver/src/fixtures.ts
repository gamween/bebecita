/**
 * Writes the taker traits fixtures the Solidity test diffs against.
 *
 * Run with `yarn fixtures`. It produces `contracts/test/fixtures/taker-traits.json`, which holds a set of
 * argument shapes and, for each one, the bytes `solver/src/takerTraits.ts` produces for it.
 * `contracts/test/TakerTraits.t.sol` then reads that file, calls the sponsor's own `TakerTraitsLib.build` on
 * the same arguments and asserts byte equality. The file is committed on purpose: it is the test vector, and
 * regenerating it is how a change to the port gets re-proved.
 *
 * The cases are chosen for where the arithmetic can go wrong rather than for coverage of the struct:
 *
 *   - every slice empty, which is the quote header and the one shape with no sums in it;
 *   - one hook slice populated, which is the first index that has to move;
 *   - both hook slices populated, which is where an off by one silently swaps the unwind and the redeposit;
 *   - a threshold, which shifts every index after it by 32;
 *   - a recipient and a deadline, the two conditional slices, including the trap where the recipient equals
 *     the taker and must therefore encode nothing at all;
 *   - the exact flag combination the project fills with, and its opposite on every bit.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { keccak256, numberToHex, type Address, type Hex } from 'viem'

import { buildTakerTraits, type TakerTraitsArgs } from './takerTraits.js'

const ROOT = resolve(import.meta.dirname, '../..')
export const FIXTURES_PATH = resolve(ROOT, 'contracts/test/fixtures/taker-traits.json')
export const FIXTURES_RELATIVE = 'contracts/test/fixtures/taker-traits.json'

const ZERO = '0x0000000000000000000000000000000000000000' as Address
const TAKER = '0xe9ab04e89cF710ED39d717875541a4dD7C892160' as Address
const OTHER = '0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4' as Address

/** Deterministic filler of a given byte length, so the fixture file is stable across runs. */
function payload(seed: string, bytes: number): Hex {
  let out = ''
  let digest = keccak256(`0x${Buffer.from(seed, 'utf8').toString('hex')}` as Hex)
  while (out.length < bytes * 2) {
    out += digest.slice(2)
    digest = keccak256(digest)
  }
  return `0x${out.slice(0, bytes * 2)}` as Hex
}

/** A `/lp/decrease` payload is a `modifyLiquidities(bytes,uint256)` call, so it is selector prefixed. */
const call = (selector: string, seed: string, bytes: number): Hex =>
  `${selector}${payload(seed, bytes).slice(2)}` as Hex

const DECREASE = call('0xdd46508f', 'decrease', 484)
const INCREASE = call('0xdd46508f', 'increase', 548)

interface Case extends TakerTraitsArgs {
  name: string
  why: string
}

const cases: Case[] = [
  {
    name: 'empty, the quote header',
    why: 'ten zero indexes and the flag word. The only shape with no arithmetic in it.',
    taker: ZERO,
    isExactIn: true,
    isAToB: true,
  },
  {
    name: 'empty, every flag clear',
    why: 'the flag word is zero, which must still produce 22 bytes and not 20.',
    taker: TAKER,
  },
  {
    name: 'empty, every flag set',
    why: 'all eight bits at once, so a mask transcribed one position off shows up here.',
    taker: TAKER,
    isExactIn: true,
    shouldUnwrapWeth: true,
    isStrictThresholdAmount: true,
    isFirstTransferFromTaker: true,
    useTransferFromAndAquaPush: true,
    isAToB: true,
    hasPreTransferInCallback: true,
    hasPreTransferOutCallback: true,
  },
  {
    name: 'hook data in the preTransferOut slice only',
    why: 'the unwind alone. Indexes 5 to 9 move, 0 to 4 do not.',
    taker: TAKER,
    isExactIn: true,
    useTransferFromAndAquaPush: true,
    isAToB: true,
    preTransferOutHookData: DECREASE,
  },
  {
    name: 'hook data in the postTransferIn slice only',
    why: 'the redeposit alone. The neighbouring index of the case above, which is where a swap hides.',
    taker: TAKER,
    isExactIn: true,
    useTransferFromAndAquaPush: true,
    isAToB: true,
    postTransferInHookData: INCREASE,
  },
  {
    name: 'hook data in both slices',
    why: 'the shape a fill uses, without the threshold. Two different lengths, so a transposition shows.',
    taker: TAKER,
    isExactIn: true,
    useTransferFromAndAquaPush: true,
    isAToB: true,
    postTransferInHookData: INCREASE,
    preTransferOutHookData: DECREASE,
  },
  {
    name: 'the live fill: threshold, both hooks, the three load bearing flags',
    why: 'exactly what buildFillTakerTraits emits and what contracts/script/Fill.s.sol builds in Solidity.',
    taker: TAKER,
    isExactIn: true,
    isFirstTransferFromTaker: false,
    useTransferFromAndAquaPush: true,
    isAToB: true,
    threshold: numberToHex(910_000_000_000_000_000_000n, { size: 32 }),
    postTransferInHookData: INCREASE,
    preTransferOutHookData: DECREASE,
  },
  {
    name: 'threshold and nothing else',
    why: '32 bytes at the front shifts every later index, and index0 is the one the library never casts.',
    taker: TAKER,
    isExactIn: true,
    threshold: numberToHex(1n, { size: 32 }),
  },
  {
    name: 'recipient and deadline, both conditional slices present',
    why: '20 then 5 bytes between the threshold and the hooks. Both are dropped when their value is neutral.',
    taker: TAKER,
    isExactIn: true,
    isAToB: true,
    threshold: numberToHex(2n ** 200n, { size: 32 }),
    to: OTHER,
    deadline: 1_800_000_000n,
    preTransferOutHookData: DECREASE,
    postTransferInHookData: INCREASE,
  },
  {
    name: 'recipient equal to the taker, which must encode nothing',
    why: 'the trap: `to == taker` is redundant, the library drops the slice, and a port that keeps it is 20 bytes long.',
    taker: TAKER,
    isExactIn: true,
    isAToB: true,
    to: TAKER,
    deadline: 0,
    preTransferOutHookData: DECREASE,
  },
  {
    name: 'exact out, strict threshold, unwrap weth',
    why: 'the direction the partial fill test exercises, with the two flags the project never sets.',
    taker: TAKER,
    isExactIn: false,
    shouldUnwrapWeth: true,
    isStrictThresholdAmount: true,
    useTransferFromAndAquaPush: true,
    isAToB: true,
    threshold: numberToHex(1_000n * 10n ** 18n, { size: 32 }),
    preTransferOutHookData: DECREASE,
    postTransferInHookData: INCREASE,
  },
  {
    name: 'every slice populated at once',
    why: 'all eleven slices non empty, so all ten indexes are distinct running sums and none can be aliased.',
    taker: TAKER,
    isExactIn: true,
    shouldUnwrapWeth: false,
    isStrictThresholdAmount: false,
    isFirstTransferFromTaker: false,
    useTransferFromAndAquaPush: true,
    isAToB: true,
    threshold: numberToHex(42n, { size: 32 }),
    to: OTHER,
    deadline: 4_000_000_000n,
    hasPreTransferInCallback: true,
    hasPreTransferOutCallback: true,
    preTransferInHookData: payload('preTransferInHook', 33),
    postTransferInHookData: payload('postTransferInHook', 64),
    preTransferOutHookData: payload('preTransferOutHook', 97),
    postTransferOutHookData: payload('postTransferOutHook', 128),
    preTransferInCallbackData: payload('preTransferInCallback', 7),
    preTransferOutCallbackData: payload('preTransferOutCallback', 11),
    instructionsArgs: payload('instructionsArgs', 64),
    signature: payload('signature', 65),
  },
]

const EMPTY: Hex = '0x'

const record = (item: Case) => ({
  name: item.name,
  why: item.why,
  taker: item.taker,
  isExactIn: item.isExactIn === true,
  shouldUnwrapWeth: item.shouldUnwrapWeth === true,
  isStrictThresholdAmount: item.isStrictThresholdAmount === true,
  isFirstTransferFromTaker: item.isFirstTransferFromTaker === true,
  useTransferFromAndAquaPush: item.useTransferFromAndAquaPush === true,
  isAToB: item.isAToB === true,
  threshold: item.threshold ?? EMPTY,
  to: item.to ?? ZERO,
  // A decimal string, not a JSON number: Foundry parses numbers as int256 and a five byte timestamp has no
  // business going through a double on the way in.
  deadline: BigInt(item.deadline ?? 0).toString(),
  hasPreTransferInCallback: item.hasPreTransferInCallback === true,
  hasPreTransferOutCallback: item.hasPreTransferOutCallback === true,
  preTransferInHookData: item.preTransferInHookData ?? EMPTY,
  postTransferInHookData: item.postTransferInHookData ?? EMPTY,
  preTransferOutHookData: item.preTransferOutHookData ?? EMPTY,
  postTransferOutHookData: item.postTransferOutHookData ?? EMPTY,
  preTransferInCallbackData: item.preTransferInCallbackData ?? EMPTY,
  preTransferOutCallbackData: item.preTransferOutCallbackData ?? EMPTY,
  instructionsArgs: item.instructionsArgs ?? EMPTY,
  signature: item.signature ?? EMPTY,
  /** What `solver/src/takerTraits.ts` produced. The Solidity test rebuilds it and compares. */
  expected: buildTakerTraits(item),
})

function main(): void {
  // The case the live book actually fills with. The test round trips this one back through the sponsor's own
  // slice readers, so it needs to know which it is, and naming it here means a reordered list fails loudly
  // rather than silently proving the wrong shape.
  const liveFillIndex = cases.findIndex((item) => item.name.startsWith('the live fill'))
  if (liveFillIndex < 0) throw new Error('no case named "the live fill", the Solidity test round trips that one')

  const fixtures = {
    note:
      'Generated by yarn fixtures. Each case is arguments for TakerTraitsLib.build plus the bytes ' +
      'solver/src/takerTraits.ts produced for them. contracts/test/TakerTraits.t.sol calls the sponsor ' +
      'library on the same arguments and asserts byte equality, which is what proves the TypeScript port.',
    count: cases.length,
    liveFillIndex,
    cases: cases.map(record),
  }
  mkdirSync(dirname(FIXTURES_PATH), { recursive: true })
  writeFileSync(FIXTURES_PATH, `${JSON.stringify(fixtures, null, 2)}\n`)

  console.log(`\n${FIXTURES_RELATIVE}, ${cases.length} cases`)
  for (const item of fixtures.cases) {
    console.log(`    ${String((item.expected.length - 2) / 2).padStart(5)} bytes  ${item.name}`)
  }
  console.log('\nforge test --match-path contracts/test/TakerTraits.t.sol proves them against the sponsor library.\n')
}

main()
