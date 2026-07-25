# FEEDBACK.md

Integrator feedback gathered while building Bebecita against the Uniswap API and the 1inch SwapVM stack,
25 to 26 July 2026. Everything below is reproducible and was hit in the course of shipping, not audited for.

## Uniswap

### 1. The LP endpoints are served from a different host, and only the OpenAPI says so

The seven `/lp/*` operations live in the same OpenAPI document as `trade-api.gateway.uniswap.org/v1` and
carry the same `x-api-key` security scheme, but the document sets a per-path `servers` override to
`https://liquidity.api.uniswap.org/` with no version prefix. None of the guides mention it.

Reproduce: fetch `https://trade-api.gateway.uniswap.org/v1/api.json` and read `paths./lp/decrease.servers`.

Impact: an integrator who builds a client from the top level `servers` block gets seven 404s and no hint
why. A reviewer grepping request logs for `trade-api` concludes the integration does not exist.

Suggestion: repeat the host in the LP guide, or serve the LP paths from the documented base URL.

### 2. `liquidityPercentageToDecrease` is an integer, so a just-in-time withdrawal can never be exact

`DecreasePositionRequest.liquidityPercentageToDecrease` is `{"type": "integer", "description": "The
percentage of liquidity to remove (1-100)."}`.

Impact: any flow that withdraws exactly what a settlement needs has to round up and carry the surplus as
float. For us that is the difference between a vault that holds nothing between fills and one that always
holds a remainder, which is the entire product.

Suggestion: accept a basis point integer, or an absolute `liquidity` amount alongside the percentage.

### 3. `generatePermitAsTransaction` is the most useful flag in the API and it is nearly invisible

`LPApprovalRequest.generatePermitAsTransaction` returns permits as on-chain transactions rather than
off-chain signatures. This is the single thing that makes a contract owned position possible, because a
contract cannot produce an EIP-712 signature, it can only execute calldata.

Suggestion: give it a section in the LP guide titled something like "positions owned by contracts". Today
it reads as a niche convenience and it is actually a capability gate.

### 4. URC-3 conformance requires `hook()` from contracts that may not be hooks

URC-3 lists among its motivating cases "maintain reserves outside the PoolManager" and "rehypothecate
assets", neither of which implies being a v4 hook. Its conformance list nonetheless makes `hook()`
mandatory. Our vault holds reserves outside the PoolManager and reports `getReserves` and
`getEffectiveLiquidity` meaningfully, but has no hook address to name and returns `address(0)`.

Suggestion: make `hook()` optional for non-hook reporters, or add a sibling interface for them.

### 5. `/lp/decrease` derives position state server side, which rules out local forks entirely

The endpoint description states the server derives liquidity, fees and ticks from on-chain data. A position
created on a local fork is therefore invisible and no calldata can be built for it, and on a fork that has
diverged the returned calldata goes stale.

This is correct behaviour, not a bug, but it is load bearing for anyone planning to develop against a fork
and it is not stated anywhere near the top of the docs.

Suggestion: one line in the LP overview saying the LP endpoints read the live chain and do not work against
private forks, with a pointer to the supported testnets.

## 1inch

### 6. The custom SwapVM example in `1inch/sdks` no longer compiles against `swap-vm@main`

`contracts/src/swap-vm/TestCustomSwapVM.sol` uses `_instructions()`, `_opcodes()` and `_notInstruction` with
a static function pointer array. `swap-vm` moved to direct dispatch via `_runOpcode(Context, uint256, bytes)`
in PR #140, merged 2026-07-03.

Impact: an integrator following the official example does not compile, and the error points at the example
rather than at the change.

Suggestion: update the sample, or copy the shape of `AquaOpcodesDebug.sol`, which is the pattern that works.

### 7. Three `Controls` instructions are unreachable from the Aqua opcode table

`Stop` (0x00), `Revert` (0x01) and `JumpIfDirection` (0x30) exist in `Controls.sol`, are dispatched by the
full `Opcodes` table, and are absent from `AquaOpcodes`. An Aqua program using any of them reverts with
`UnknownOpcode`.

Impact: an Aqua program cannot halt early, so conditional strategies are not expressible on the Aqua router.

Reproduce: build a program containing opcode `0x00` and run it through `AquaSwapVMRouter`.

Suggestion: three `else if` branches in `AquaOpcodes._runOpcode`. Our `BebecitaOpcodes` carries them.

### 8. The canonical instruction ordering makes protocol fees unusable for a capital efficient maker

The SwapVM whitepaper gives the canonical ordering as `aquaProtocolFee`, then the swap instruction, then
`flatFee`. But `_aquaProtocolFeeAmountInXD` pulls `tokenIn` from the maker during `runLoop`, before the taker
has paid, and its own NatSpec states the maker must already hold sufficient balance or the swap reverts.

A maker whose inventory is deployed rather than idle, which is the state the Aqua whitepaper describes as
efficient, therefore cannot pay a protocol fee at all. The only usable fee instruction for such a maker is
`FlatFeeAmountIn`, which is purely arithmetic.

Suggestion: a protocol fee variant that settles after `_transferIn`, or that draws on `amountNetPulled`.

### 9. No testnet deployment is documented, although one exists

The Aqua README lists 13 mainnet deployments and no testnet. The official Aqua is in fact deployed on
Ethereum Sepolia at `0x499943E74FB0cE105688beeE8Ef2ABec5D936d31`, the canonical address, with bytecode
identical to Base, and the official `AquaSwapVMRouter` is at `0x8fdd04dbf6111437b44bbca99c28882434e0958f`.

Impact: teams assume a mainnet fork is the only option and inherit every problem that comes with it.

Suggestion: add a testnet row to the deployments table.
