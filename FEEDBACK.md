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

### 6. Four request field names in the LP API are inconsistent, and the validation errors name the wrong thing

Building the create flow cost four round trips, each spent on a key name rather than on anything semantic.

| Sent | Expected | What the 400 said |
|---|---|---|
| `lpTokens: [{ address, amount }]` | `{ tokenAddress, amount }` | `"lpTokens[0].tokenAddress" is not allowed to be empty` |
| `newPool: { token0, token1, ... }` | `token0Address`, `token1Address` | `"pool" does not match any of the allowed types` |
| `independentToken: "TOKEN_0"` plus `independentAmount` | `independentToken: { tokenAddress, amount }` | `cannot decode message uniswap.liquidity.v2.CreateToken from JSON: "TOKEN_0"` |
| `claim_fees` with `nftTokenId` | `tokenId`, though `/lp/increase` and `/lp/decrease` both say `nftTokenId` | `ClaimFeesRequest validation error: "tokenId" is not allowed to be empty` |

Impact: the first message reads as a missing value, not a wrong key. The second names the union rather than the
offending member. The third leaks an internal protobuf message type, and a reader who trusts it goes looking for
a `CreateToken` enum that does not exist in any published schema.

Suggestion: report unknown keys by name, and settle on one spelling of the position identifier across the seven
LP paths. The last row is the one that outlived the create flow and cost time again during settlement, so it is
written up on its own in finding 10.

### 7. `/lp/create` accepts a contract as `walletAddress` and returns a transaction most contracts cannot execute

We asked for a position owned by a contract, which is the whole shape of this project. The API accepted the
contract address without complaint and returned the same payload with the vault as recipient and `from`.

That payload is a `multicall(bytes[])` on the v4 PositionManager wrapping `initializePool` and
`modifyLiquidities`. A contract that forwards a fixed selector, which is what a vault holding other people's
collateral should be, cannot execute it. The workable shapes are to split the multicall by hand, or to mint to
an EOA and transfer the ERC721 afterwards. We did the second, because the first also requires deploying the
owner against a tokenId read from `nextTokenId()` before the mint, which races every other position minted
meanwhile.

Suggestion: a `recipient` field distinct from the payer, or a documented note that a contract `walletAddress`
must be able to execute `multicall`. Either would make contract owned positions a first class flow.

### 8. The Permit2 half of `check_approval` is the half that matters, and it is the easy one to miss

For a v4 pair with `generatePermitAsTransaction: true`, `/lp/check_approval` returns four transactions: an ERC20
`approve` to Permit2 per token, then a Permit2 `approve(token, positionManager, amount, expiration)` per token.
Only the second pair actually lets the PositionManager pull anything, and it is invisible to anyone who checks
`IERC20.allowance` and concludes the wallet is ready.

For a contract owner this is the concrete consequence of finding 3: the contract needs an entry point for the
Permit2 call specifically, since Permit2's `approve` is not an ERC20 `approve`. Ours is `approveViaPermit2`.

Suggestion: say in the LP guide that v4 approvals are two legged, and that the second leg is the funding one.

### 9. `nftTokenId` must be a JSON string, and a JSON number is rejected as an undecodable value

`/lp/decrease` and `/lp/increase` both take the position as `nftTokenId`. The obvious encoding for an integer
identifier is a JSON number, and it fails.

```
$ curl -X POST https://liquidity.api.uniswap.org/lp/decrease -d '{..., "nftTokenId": 37804, ...}'
400 {"code":"invalid_argument","message":"cannot decode field
     uniswap.liquidity.v2.DecreasePositionRequest.nft_token_id from JSON: 37804"}
```

The same request with `"nftTokenId": "37804"` returns the calldata.

Impact: the message names the value, `37804`, which is a perfectly valid tokenId, so it reads as "this
position does not exist" rather than "this type is wrong". We lost a round trip checking the position on chain
before rereading the request. The response also leaks the internal protobuf field name, `nft_token_id`, which
does not appear in the published schema and cannot be sent either.

Suggestion: accept a JSON number for an integer field, or say `expected string` in the error.

### 10. `/lp/claim_fees` names the position `tokenId`, where its two siblings name it `nftTokenId`

Three endpoints in the same document take the same position identifier under two different names.
`/lp/decrease` and `/lp/increase` want `nftTokenId`. `/lp/claim_fees` wants `tokenId` and rejects `nftTokenId`.

```
$ curl -X POST https://liquidity.api.uniswap.org/lp/claim_fees -d '{..., "nftTokenId": "37804"}'
400 {"code":"invalid_argument","message":"RequestValidationError: ClaimFeesRequest validation error:
     \"tokenId\" is not allowed to be empty"}
```

Impact: the error names `tokenId`, the field that is absent, and never mentions `nftTokenId`, the field that
was sent. It therefore reads as an empty value rather than an unrecognised key, and the natural next move is
to check the value rather than the name. This is the same failure shape as the `lpTokens[0].tokenAddress`
message in finding 6, and it is worth calling out separately because here the correct name is different on
neighbouring endpoints rather than merely misspelled.

Suggestion: accept `nftTokenId` on `/lp/claim_fees` as an alias, and report unknown keys by name.

### 11. `/lp/pool_info` is the only LP endpoint that reports no rate limit, and it is the one a read-only client leans on

Every `/lp/*` endpoint we call answers with `x-ratelimit-limit` and `x-ratelimit-remaining`, except
`/lp/pool_info`, which returns neither. Same host, same key, same session, five endpoints:

```
$ for ep in pool_info claim_fees decrease increase check_approval; do
    curl -sD - -o /dev/null -X POST https://liquidity.api.uniswap.org/lp/$ep \
      -H "x-api-key: $UNISWAP_API_KEY" -H 'content-type: application/json' -d "$BODY"
  done

/lp/pool_info        200   NO x-ratelimit HEADER
/lp/claim_fees       200   x-ratelimit-limit: 6  x-ratelimit-remaining: 5
/lp/decrease         200   x-ratelimit-limit: 6  x-ratelimit-remaining: 5
/lp/increase         200   x-ratelimit-limit: 6  x-ratelimit-remaining: 5
/lp/check_approval   400   x-ratelimit-limit: 6  x-ratelimit-remaining: 5
```

Note the 400 still reports. So the header is not tied to success, and its absence on `/lp/pool_info` is not a
property of that response either: it is the endpoint.

Impact: with a limit of 6, a client has to budget, and the only honest way to budget is to read the header the
gateway sends. `/lp/pool_info` is a pure read that needs no wallet and no signature, so it is exactly what a
dashboard or an indexer polls, and it is the call whose cost cannot be observed. We hit this building a panel
that displays the quota next to every request: on the one endpoint any visitor can trigger, the panel has
nothing to display, which reads to a user as a broken panel rather than as a missing header. Consuming a budget
invisibly is worse than a low budget.

Suggestion: send `x-ratelimit-limit` and `x-ratelimit-remaining` on `/lp/pool_info` as well. If the omission is
deliberate because the endpoint is metered differently or not at all, say so in the OpenAPI document, because
from the client side an absent header and an unmetered endpoint are indistinguishable.

## 1inch

### 12. The custom SwapVM example in `1inch/sdks` no longer compiles against `swap-vm@main`

`contracts/src/swap-vm/TestCustomSwapVM.sol` uses `_instructions()`, `_opcodes()` and `_notInstruction` with
a static function pointer array. `swap-vm` moved to direct dispatch via `_runOpcode(Context, uint256, bytes)`
in PR #140, merged 2026-07-03.

Impact: an integrator following the official example does not compile, and the error points at the example
rather than at the change.

Suggestion: update the sample, or copy the shape of `AquaOpcodesDebug.sol`, which is the pattern that works.

### 13. Three `Controls` instructions are unreachable from the Aqua opcode table

`Stop` (0x00), `Revert` (0x01) and `JumpIfDirection` (0x30) exist in `Controls.sol`, are dispatched by the
full `Opcodes` table, and are absent from `AquaOpcodes`. An Aqua program using any of them reverts with
`UnknownOpcode`.

Impact: an Aqua program cannot halt early, so conditional strategies are not expressible on the Aqua router.

Reproduce: build a program containing opcode `0x00` and run it through `AquaSwapVMRouter`.

Suggestion: three `else if` branches in `AquaOpcodes._runOpcode`. Our `BebecitaOpcodes` carries them.

### 14. The canonical instruction ordering makes protocol fees unusable for a capital efficient maker

The SwapVM whitepaper gives the canonical ordering as `aquaProtocolFee`, then the swap instruction, then
`flatFee`. But `_aquaProtocolFeeAmountInXD` pulls `tokenIn` from the maker during `runLoop`, before the taker
has paid, and its own NatSpec states the maker must already hold sufficient balance or the swap reverts.

A maker whose inventory is deployed rather than idle, which is the state the Aqua whitepaper describes as
efficient, therefore cannot pay a protocol fee at all. The only usable fee instruction for such a maker is
`FlatFeeAmountIn`, which is purely arithmetic.

Suggestion: a protocol fee variant that settles after `_transferIn`, or that draws on `amountNetPulled`.

### 15. No testnet deployment is documented, although one exists

The Aqua README lists 13 mainnet deployments and no testnet. The official Aqua is in fact deployed on
Ethereum Sepolia at `0x499943E74FB0cE105688beeE8Ef2ABec5D936d31`, the canonical address, with bytecode
identical to Base, and the official `AquaSwapVMRouter` is at `0x8fdd04dbf6111437b44bbca99c28882434e0958f`.

Impact: teams assume a mainnet fork is the only option and inherit every problem that comes with it.

Suggestion: add a testnet row to the deployments table.

### 16. The AquaSwapVMRouter deployed on Sepolia is not the contract the published source builds

`0x8fdd04dbf6111437b44bbca99c28882434e0958f` on Ethereum Sepolia answers `hash(order)` correctly, and Aqua
registers a strategy shipped under it correctly, so it is recognisably an `AquaSwapVMRouter`. But `quote()`
reverts with completely empty return data for an order built against `swap-vm` at the commit this project pins,
and it does so even for an order that was never shipped, where a router built from that source reverts with
`SafeBalancesForTokenNotInActiveStrategy` carrying its four arguments. The runtime bytecode is also a different
size from a router built from that source.

Reproduce, with any well formed modern order:

```
cast call 0x8fdd04dbf6111437b44bbca99c28882434e0958f \
  "quote((address,uint256,bytes),uint256,bytes)(uint256,uint256,bytes32)" \
  "(<maker>,<traits>,<data>)" <amount> <takerTraits> --rpc-url <sepolia>
# execution reverted, data: "0x"
```

The same call against a router deployed from the current source returns named errors throughout.

Impact: a team that reads the README, finds the deployed address, and builds against `main` cannot execute
against that deployment and gets no error to work from. We only found it because we tried to run our own book
through your router as a control experiment.

Suggestion: publish the commit each deployment was built from, or redeploy the testnet router from `main`. A
deployments table with a commit column would remove the whole class of problem.
