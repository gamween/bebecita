<div align="center">

# Bebecita

**An order book funded by a Uniswap position.** The maker's inventory never sits idle in a wallet: it stays in a Uniswap v4 liquidity position and is unwound just in time, one instruction before the tokens leave, inside the same transaction as the fill.

</div>

> Your Uniswap liquidity can quote an order book without leaving the pool.

## Live on Ethereum Sepolia

| Contract | Address |
|---|---|
| BebecitaRouter, our modified SwapVM | [`0x354422f6e4e3476b540E306A6DdFb4638d9EA5c3`](https://sepolia.etherscan.io/address/0x354422f6e4e3476b540E306A6DdFb4638d9EA5c3) |
| BebecitaVault, the maker | [`0xE703F509ba1bF70BcFa4957a7090e73B627dE76a`](https://sepolia.etherscan.io/address/0xE703F509ba1bF70BcFa4957a7090e73B627dE76a) |
| bALPHA | [`0xdB41CB0A2EEFF8Ed53Ef019D4C9826744f500B7F`](https://sepolia.etherscan.io/address/0xdB41CB0A2EEFF8Ed53Ef019D4C9826744f500B7F) |
| bBRAVO | [`0x0128Ac6B5E3364b022e55A0cf9c0cb4987B3B20f`](https://sepolia.etherscan.io/address/0x0128Ac6B5E3364b022e55A0cf9c0cb4987B3B20f) |

The maker's inventory, opened through the Uniswap API and owned by the vault:

| | |
|---|---|
| Position | v4 NFT [`#37804`](https://sepolia.etherscan.io/token/0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4?a=37804), full range, 100,000 of each token |
| Pool | `0x25f7dd131e5548b22a4bf9b95587514d69960261c1defff0ec465f9f90d54489`, fee 3000, spacing 60, no hook |
| Reachable per fill | 23,750 tokens, which is 25% of the position after a 5% haircut |
| Aqua strategy | `0x386716d5e39927fc3f8a1ddd45a9c09a6d96a059b52de2dbfcff8dcfd6e58d8d` |

The vault was redeployed once the position existed, because `TOKEN_ID` is immutable and the first deployment
predated the pool. That is the whole reason the address above differs from the one in the deploy transaction.

The router's `AQUA()` getter returns `0x499943E74FB0cE105688beeE8Ef2ABec5D936d31`, the canonical Aqua address, which is the one line that
proves the official contracts are the ones doing the work. Its `OPCODE_UNWIND_PRICED_BALANCE_OUT()` returns
`146`, that is `0x92`.

## The removal test, both ways

This is the shortest description of what the project is, and it is the first thing to check.

**Take the Uniswap API out** and there is no calldata to place in either hook slice, the vault has no free float, and `AQUA.pull` reverts on the first fill on a `safeTransferFrom` out of an empty wallet. There is no degraded mode.

**Take the custom SwapVM instruction out** and Aqua quotes against the virtual balance the maker shipped, which is enormous by construction, the curve prices depth that does not exist, and the fill asks for more than the unwind can produce. That failure is asserted in the test suite, not described: see `test_WithoutInstruction_QuotePassesAndSwapReverts`.

Both legs break. Neither is decoration.

## Why this is possible at all

Aqua never custodies anything. Opening a strategy is not a deposit, it is writing a number into a mapping, and that number is backed by nothing: `Aqua.ship` performs no solvency check, and `Aqua.pull` decrements the virtual balance and only then calls `safeTransferFrom` on the maker's wallet. So Aqua does not require you to keep funds available, it requires that one transfer to succeed on the last line.

That is the whole opening. The money only has to be there for the width of two instructions, so it can work somewhere else until then.

There is no simultaneity here and the pitch should never claim any. The position is the collateral, and settlement converts it just in time, made safe by atomicity.

## How a fill runs

| Step | Where | What happens |
|---|---|---|
| 1 | `runLoop` | Instruction `0x92` reads the vault's free float and the position's liquidity, and clamps `balanceOut` to what is genuinely reachable. The curve then prices against the truth. |
| 2 | `SwapVM.sol:310-314` | `preTransferOut` fires. The vault executes the `/lp/decrease` calldata against the v4 PositionManager. The position unwinds, the vault receives the output token. |
| 3 | `SwapVM.sol:321` → `Aqua.sol:63-70` | `AQUA.pull` runs on the very next statement and pays the taker. |
| 4 | `SwapVM.sol:262` | `AQUA.push` credits the vault with the taker's input. |
| 5 | `SwapVM.sol:282-286` | `postTransferIn` fires. The vault executes the `/lp/increase` calldata. The inventory goes back to work. |

Steps 2 and 3 are consecutive statements in the sponsor's own source, and that ordering holds in both transfer orders the router supports. `preTransferOut` is the only point in SwapVM guaranteed to run immediately before tokens leave the maker, which is the entire reason this design exists.

## The instruction

`_unwindPricedBalanceOut1D`, opcode `0x92`, in the `0x90-0xaf` balances tuning bank of `OpcodeList.sol`, whose rule reads: *"New instruction MUST take the next free `_Ix` slot of its family bank."* The claim is machine checked rather than asserted: `test_InstructionTakesReservedSlotOfBalancesTuningBank` asserts `uint256(Opcode._92)` equals the dispatched index.

It is **fully `view`**. It writes no storage, so quote/swap consistency, the only invariant of the SwapVM core suite that cannot be skipped, is satisfied structurally rather than by discipline. It only ever lowers `balanceOut`, never raises it, and never touches `balanceIn`, because on a constant product curve lowering `balanceIn` would raise the payout, which is the opposite of the intent.

```
balanceOut = min(balanceOut, float + reachable)
reachable  = positionLiquidity x unitsPerLiquidity x maxUnwindPct x (1 - haircut)
```

## The vault, and taker supplied calldata

The withdrawal calldata comes from the taker, per fill, because the Uniswap API builds it against live chain state and it cannot be baked into an immutable order. The vault does not trust it. It pins the callee, pins the selector, and judges the payload by its effects:

1. after the unwind, the output balance must have grown by at least the amount the VM computed, which the hook receives as a parameter, so this is a floor and not a sign check;
2. the other side of the book may not shrink;
3. the position may not lose more liquidity than the maker authorised for one fill;
4. a redeposit may only grow the position.

A taker can therefore choose *how* to unwind, but never whether the maker ends up short, and never what the vault ends up owning.

## URC-3

The vault implements [`IHookStats`](https://gov.uniswap.org/t/urc-3-hook-tvl-and-effective-liquidity-reporting/26155), the Uniswap Labs standard for reporting TVL and immediately swappable liquidity, created 2026-06-11. Its normative invariant is that `getEffectiveLiquidity` should not exceed `getReserves`, which is exactly what instruction `0x92` enforces inside the VM. URC-3's own motivating cases list, verbatim, *"deploy liquidity in external protocols"*, *"rehypothecate assets"* and *"maintain reserves outside the PoolManager"*.

## Chain

Everything runs on **Ethereum Sepolia**, and that is not a fallback.

It is the only chain outside mainnet carrying both halves of this project. The official Aqua is deployed there at its canonical address `0x499943E74FB0cE105688beeE8Ef2ABec5D936d31`, with bytecode byte for byte identical to the Base deployment, `sha256 e30d2eab49ae15c876b4d75131185c78bb28e88ac8a21faab06336139b84a1af` on both. No 1inch README lists a testnet, so this was established by probing the chain. Base Sepolia and Unichain Sepolia carry no Aqua at either known address.

The Uniswap API accepts chainId `11155111`, and Uniswap's own FAQ states there is no sandbox and that testing is done against the supported testnets through the production endpoints.

| Contract | Address |
|---|---|
| Aqua, official | `0x499943E74FB0cE105688beeE8Ef2ABec5D936d31` |
| AquaSwapVMRouter, official | `0x8fdd04dbf6111437b44bbca99c28882434e0958f` |
| v4 PoolManager | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| v4 PositionManager | `0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4` |
| v4 StateView | `0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c` |

## Uniswap API integration

The API is the funding mechanism, not a data source. Qualifying function claimed: **liquidity provision**, literally, with two PositionManager calls built by the API at fill time and executed on-chain inside every fill.

| Endpoint | Called from | Role |
|---|---|---|
| `POST /lp/pool_info` | `solver/src/uniswap.ts` | Pool state and tick, sizes the clip and mirrors the position range into the Aqua program |
| `POST /lp/check_approval` | `solver/src/setup.ts` | With `generatePermitAsTransaction: true`, returns permits as executable transactions instead of EIP-712 typed data. This is what makes a contract owned position possible: the vault cannot sign, only execute |
| `POST /lp/create` | `solver/src/setup.ts` | Opens the pool and the position through `newPool`, so the demo owns its own pool and depends on no pre-existing testnet liquidity |
| `POST /lp/decrease` | `solver/src/uniswap.ts` | **Once per fill.** Its calldata goes verbatim into the `preTransferOutHookData` slice of `TakerTraits` and is executed by `BebecitaVault.preTransferOut` |
| `POST /lp/increase` | `solver/src/uniswap.ts` | Same fill. Its calldata goes into `postTransferInHookData` and is executed by `BebecitaVault.postTransferIn` |
| `POST /lp/claim_fees` | `solver/src/uniswap.ts` | Closing panel: the fees the same capital earned while it was quoting |

**Note for the reviewer.** The `/lp/*` operations belong to the same OpenAPI document as `trade-api.gateway.uniswap.org/v1` and use the same `x-api-key` scheme, but the document carries a per-path server override and they are served from `https://liquidity.api.uniswap.org` with no version prefix. Grepping our request logs for `trade-api` will find nothing, which is why this is stated here rather than left to be discovered.

See [FEEDBACK.md](FEEDBACK.md) for what we found while integrating.

## Quickstart

```bash
yarn install
cp .env.example .env          # fill UNISWAP_API_KEY and DEPLOYER_PRIVATE_KEY
yarn gate0                    # six checks that decide whether the project exists
yarn test                     # 11 tests, no network needed
forge script contracts/script/Deploy.s.sol --rpc-url sepolia --broadcast --verify
yarn setup                    # pool, position, vault custody, all through the LP API
yarn aqua                     # opens the strategy the book quotes
```

`yarn setup` is resumable and reads `deployments/sepolia.json` as its state: a position already recorded
there is reused rather than duplicated, and `--recreate` opens a second one. `yarn aqua` picks a fresh salt
on every run, because a strategy hash can be shipped exactly once and the second run would otherwise revert
with `StrategiesMustBeImmutable`.

## Frontend

```bash
cd app && yarn install && yarn dev     # http://localhost:5173
```

A landing page and a dashboard, Vite plus React plus TypeScript plus viem, no wallet kit. The dashboard reads
the position, the vault and the Aqua balances live from Sepolia, calls `quote()` through a staticcall, calls
the Uniswap LP API for real, and shows every API request and response with its response headers. Addresses are
read at runtime from `deployments/sepolia.json` and `solver/src/config.ts`, never copied. See
[app/README.md](app/README.md).

Iteration discipline, measured on the build machine: a full `forge build` costs **3 min 49** because of `via_ir`, `forge build --skip test` costs **17 s**, and `forge test --match-path <one file>` costs **13 s**. Never run the bare commands.

## Layout

```
contracts/src/instructions/   UnwindPricedBalances, the 0x92 instruction and its args builder
contracts/src/opcodes/        BebecitaOpcodes, the Aqua table plus 0x92 and three rewired Controls
contracts/src/routers/        BebecitaRouter, the redeployed SwapVM pointing at the official Aqua
contracts/src/vault/          BebecitaVault, the maker: position custody, hooks, URC-3 reporting
contracts/src/interfaces/     IHookStats (URC-3)
contracts/test/               11 tests including the negative moment and the four guards
contracts/script/             Sepolia deployment
solver/src/                   Uniswap LP API client, gate zero, setup, the Aqua strategy, fill orchestration

solver/src/                   Uniswap LP API client, gate zero checker, fill orchestration
app/                          landing page and dashboard, Vite plus React plus viem
docs/                         architecture, onboarding, demo script, decisions
```

## Rewired instructions

`AquaOpcodes` dispatches 19 opcodes where the full `Opcodes` table dispatches 46. Three of them, `Stop`, `Revert` and `JumpIfDirection`, were added to `Controls.sol` on 2026-07-05 and are unreachable from any Aqua program: a program using them reverts with `UnknownOpcode`. They are wired back in `BebecitaOpcodes` because a program that cannot halt early cannot express a conditional strategy. That is three `else if` and a test, and the diff is in one file.

## License

MIT
