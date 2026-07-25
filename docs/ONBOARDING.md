# Onboarding

For the second dev. Read this, run four commands, and you are productive. Fifteen minutes.

## What we are building, in sixty seconds

A maker on 1inch Aqua whose inventory is not in its wallet. It sits in a Uniswap v4 liquidity position and
earns fees. When someone fills our order book, the position is unwound just in time, one instruction before
the tokens leave, inside the same transaction.

Aqua makes that possible because it never custodies anything: opening a strategy just writes a number into a
mapping, and the money only has to exist for the width of one `safeTransferFrom` at the very end. So it can
work somewhere else until then.

Two protocols, both load bearing. Remove the Uniswap API and there is no calldata to execute, the vault is
empty, the first fill reverts. Remove our custom SwapVM instruction and Aqua quotes depth the maker cannot
deliver, and every fill dies at the last statement.

Never say "the same money is in two places". Say "the position is the collateral, and settlement converts it
just in time, atomically".

## Setup

```bash
git clone git@github.com:gamween/bebecita.git && cd bebecita
yarn install
cp .env.example .env          # ask Fianso for the API key, generate your own deployer key
yarn test                     # 11 tests, no network, should be green in 13 seconds
yarn gate0                    # five live checks against Sepolia and the Uniswap API
```

## The one rule that will save you an hour

`via_ir` is on, so a bare `forge build` recompiles the whole test suite and costs **3 min 49**. Measured, not
estimated.

```bash
forge build --skip test                                  # 17 s
forge test --match-path contracts/test/Bebecita.t.sol    # 13 s
forge build                                              # 3 min 49, avoid
npm run snapshot                                         # starts with a clean, never run this
```

## Where things are

| Path | What it is |
|---|---|
| `contracts/src/instructions/UnwindPricedBalances.sol` | The custom instruction, opcode `0x92`. Pure `view`, clamps `balanceOut`. |
| `contracts/src/opcodes/BebecitaOpcodes.sol` | Our opcode table. Subclasses `AquaOpcodes`, adds `0x92`, rewires three dead `Controls`. |
| `contracts/src/routers/BebecitaRouter.sol` | The redeployed SwapVM. Points at the official Aqua. |
| `contracts/src/vault/BebecitaVault.sol` | The maker. Holds the position, implements the hooks and their four guards, reports URC-3. |
| `contracts/test/Bebecita.t.sol` | Everything above, asserted. Start here to understand the system. |
| `solver/src/uniswap.ts` | LP API client. Read the header comment, it contains the host trap. |
| `solver/src/gate0.ts` | The six checks that decide whether the project exists. |
| `solver/src/setup.ts` | `yarn setup`. Pool, position, vault redeploy, ERC721 custody. Resumable. |
| `solver/src/aqua.ts` | `yarn aqua`. Builds the order, ships it from the vault, checks the hash. Its builders are exported for the fill path. |

## Things that will bite you

**Ship the exact bytes.** On the SwapVM path the Aqua strategy blob must be `abi.encode(order)` byte for
byte, because the router looks balances up under `keccak256(abi.encode(order))`. One byte off and
`safeBalances` reverts with nothing pointing at the encoding.

**A strategy hash can only be shipped once, ever.** `Aqua.ship` requires `tokensCount == 0` and `dock` sets
it to `0xff` permanently. Re-running a demo needs a new salt in the program, which is what the `Salt` opcode
`0x02` is for. If your second run reverts with `StrategiesMustBeImmutable`, that is this.

**The LP endpoints are on another host.** `https://liquidity.api.uniswap.org`, not `trade-api`. The OpenAPI
document has a per-path server override. This is in the client already, do not undo it.

**Do not copy the SwapVM example from `1inch/sdks`.** `TestCustomSwapVM.sol` uses `_instructions()` and
`_opcodes()`, removed from main on 2026-07-03. Copy `AquaOpcodesDebug.sol` instead, which is what our table
already does.

**The vault's `TOKEN_ID` is immutable, so the vault is deployed after the position.** `yarn setup` creates the
position first and then runs `contracts/script/DeployVault.s.sol` against the tokenId that came out of the mint.
If you ever recreate the position, the vault address changes with it, and `deployments/sepolia.json` is the
source of truth for both.

**`IS_FIRST_TRANSFER_FROM_TAKER` stays at zero.** That places `postTransferIn` after the pull, which is what
lets the redeposit be two sided, which is what keeps the position in range and therefore earning. Flipping it
silently changes the whole hook ordering.

**Aqua reverts do not look like Aqua reverts.** When the maker is short, the failure surfaces as
`ERC20InsufficientBalance` from the token, after the virtual balance was already decremented in memory. An
`expectRevert` typed on an `IAqua` error will never match.

## Environment

Everything is on **Ethereum Sepolia**, chainId `11155111`, and this is deliberate. It is the only chain
outside mainnet that carries the official Aqua, and we found that by probing the chain rather than reading a
README, because no 1inch README lists a testnet. Addresses are in `solver/src/config.ts` and in the
top-level README.

No forks. The Uniswap API derives position state server side from the live chain, so a fork is invisible to
it and its calldata goes stale.

## Working agreement

Commit at every milestone, on a branch, with a real message. ETHGlobal treats repositories with single
commits of large files as unqualified by default, and 1inch checks commit history explicitly. This is the
cheapest gate in the whole hackathon and it is lost by not caring.

Anything you learn about the sponsors' APIs while integrating goes into `FEEDBACK.md` immediately. It is a
hard qualifying requirement for the Uniswap track, and the file is currently one of our strongest assets.
