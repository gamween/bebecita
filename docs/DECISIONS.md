# Decisions

What was decided, why, and what was deliberately left out. Written so nobody relitigates a settled question at
four in the morning.

## Chain: Ethereum Sepolia, and it is not a fallback

Sepolia is the only chain outside mainnet that carries both halves of this project.

The official Aqua is deployed there at its canonical address `0x499943E74FB0cE105688beeE8Ef2ABec5D936d31`,
with bytecode byte for byte identical to the Base deployment, sha256
`e30d2eab49ae15c876b4d75131185c78bb28e88ac8a21faab06336139b84a1af` on both. No 1inch README lists a testnet,
so this was found by probing the chain rather than reading a table. Base Sepolia and Unichain Sepolia carry
nothing at either known Aqua address.

The Uniswap API accepts chainId 11155111, and Uniswap's own FAQ states there is no sandbox and that testing is
done against the supported testnets through the production endpoints.

That single fact removed an entire branch of the plan: no fork, no borrowed position, no impersonation
cheatcode, no liquidity drift, no terminal only demo. The judges open a public explorer instead.

## No fork, ever

`/lp/decrease` derives liquidity, fees and ticks from on-chain data server side. A position created on a local
fork is therefore invisible to the API, which can build nothing for it, and on a diverged fork the returned
calldata goes stale within a couple of fills. Forking is not a cheaper version of this project, it is a
broken one.

## Both tracks, one product

1inch "Build an Aqua App" and Uniswap "Best Uniswap API Integration". ETHGlobal allows up to three partner
prizes per submission and multiple tracks of one partner count as one, so two costs nothing extra.

Dropping 1inch was considered and is not available: Aqua is the spine. Remove it and there is no order book,
no settlement, and a vault that withdraws liquidity for nobody.

The Uniswap qualifying function claimed is liquidity provision, literally, not routing and not swapping. The
`/lp/*` endpoints are the settlement mechanism rather than a price feed, which is both true and unusual: most
submissions will call `POST /swap`.

## Protocol: V4

The case for V3 was avoiding v4 Actions packing, Permit2, and native ETH pools. All three fell away. We never
pack Actions ourselves because the API returns calldata already built. `generatePermitAsTransaction` removes
the signature path, which is what makes a contract owned position possible at all. Native ETH is avoided by
using two ERC20s. And the v4 addresses are verified on all three testnets while the v3 ones are not.

## Our own tokens and our own pool

Two freshly minted ERC20s and a pool created through the `newPool` field of `/lp/create`. No faucet
dependency, no reliance on whatever thin liquidity happens to exist on Sepolia, round readable amounts on
screen, and a pool whose only LP is us. That last part is what makes ticks, `pool_info` and the withdrawal
deterministic, so the demo replays identically. No mainnet fork can offer that.

## IS_FIRST_TRANSFER_FROM_TAKER pinned to zero

It places `postTransferIn` after the pull, which makes a two sided redeposit legal, which keeps the position
in range, which is the only way it earns fees. In the other ordering the redeposit would be single sided,
forcing an out of range position that earns nothing and guts the thesis. The solver is our own taker contract,
so we control the bit.

## Traits built with the sponsor's own builders

`MakerTraitsLib.build` and `TakerTraitsLib.build` both exist. Earlier planning treated hand encoding the 22
byte traits header and its eleven slices as the riskiest line item in the project. It is not a line item at
all: use their builders in Solidity and the whole class of one byte offset bugs disappears.

## Extension style: subclass, do not fork

`BebecitaOpcodes` subclasses `AquaOpcodes` and overrides `_runOpcode` with a `super` fallthrough, exactly like
`AquaOpcodesDebug`. Not one line of the sponsor's source is modified. The official contracts are used as
published and only the SwapVM router is redeployed, which the 1inch track allows in so many words.

The instruction takes the reserved `_92` slot of the balances tuning bank, per the rule written at the top of
`OpcodeList.sol`. The claim is asserted in a test rather than in prose, so nobody has to take the README's
word for it.

## Do not copy the sponsor's own example

`contracts/src/swap-vm/TestCustomSwapVM.sol` in `1inch/sdks` uses `_instructions()` and `_opcodes()`, removed
from `swap-vm` main on 2026-07-03 by PR #140. Following the official example does not compile. Copy
`AquaOpcodesDebug.sol` instead. Reported in `FEEDBACK.md`.

## Curve: XYCConcentrate 0x51, bounded by the position

`XYCSwap` was the obvious first choice and it is the wrong one. It never clamps its own output, so the moment
instruction `0x92` lowers `balanceOut` below what a taker asked for, an exact-out order gets an arithmetic
panic out of the VM rather than an answer. `XYCConcentrate` clamps on `balanceOut` and re-solves the other
side, in both directions, which is the partial fill behaviour the sponsor's own `TakerTraitsLib.validate` is
written to accept.

That is the reason to switch. The second reason is what makes it ours: `0x51` takes two price bounds, and they
are the tick bounds of the position that funds the book, read from `POST /lp/pool_info` at ship time and
compiled into the program.

Full range does not fit the instruction's 1e18 fixed point, `sqrt(1.0001^-887220)` truncating to zero, and the
choice made instead is written at the constant in `solver/src/aqua.ts`: clamp the range to a factor of `1e9` on
the sqrt price either side of the live spot, which is ticks `-414486` to `414486`. Nothing is fabricated. A
narrower position compiles its own real ticks and the book concentrates with it.

The price did not move on this. Measured on the fill that shipped it, `915.372435469721101398` out against
`915.372435390345788254` for the same balances on `0x50`, which is a relative difference of `8.7e-11`.

## The rebalance is not inside the fill

`yarn rebalance` sells the inventory the book accumulates back into the pool and puts both sides into the
position. The obvious place to do that is the fill itself, in `postTransferIn`, where the vault already holds
the taker's input and already executes calldata the Uniswap API built. It is deliberately not there, and there
are two reasons rather than one.

The settlement path is the one thing that must not grow new failure modes. Everything in this design that can
revert already lives in those two hooks: four guards, a payload the taker supplied, and two PositionManager
calls whose success is the fill's success. Adding a swap would add a router, a second pool interaction, a
slippage bound and a deadline to that path, and each of them turns a market condition into a failed fill rather
than into a failed maintenance job. A rebalance that fails at four in the morning costs a re-run. A fill that
fails costs the demo, and worse, it costs it in front of somebody.

And a maker that hedged into the same pool on every fill would be selling what it just bought at the pool price
minus the pool fee, in the same transaction. That maker can never quote better than the pool it hedges into,
because whatever spread it charges is handed straight back on the hedge, and a taker comparing the two would
trade the pool directly. It is a router with extra steps and a worse price. Quoting a book means holding a
position against the flow and choosing when to unwind it, which is a decision that belongs to the desk, between
fills, at a size and a moment of its own choosing.

There is a smaller third reason that is not load bearing but is real. Fifteen fills produced 23,947 bBRAVO of
drift, and one rebalance cleared it in five transactions and one 0.3% pool fee. Hedging per fill would have
paid that fee fifteen times, and the gas fifteen times, for a worse end state.

Where it runs instead needed nothing new on chain. `BebecitaVault.sweep` is owner only and already existed, so
the whole operation happens at the owner level: the vault is the book, the owner is the desk. Adding a
rebalance entry point to the vault was considered and rejected on cost rather than on taste. `TOKEN_ID` is
immutable, so a redeploy cascades into transferring the position NFT and re-shipping every strategy, which is a
large price for an entry point that already exists in a more general form.

## Ruled out on purpose

The instruction as a wrapper with a nested `runLoop`. Four hours on the only component of the critical path,
for a gain invisible on screen, when guard one already enforces a floor.

A second instruction at `0x93` for minimum fill size. The answer to a thin contribution is a composed program,
not a second opcode.

Shipping `0x51` with a tight range on a full range position, which would have made the exact-in clamp reachable
at a small clip and looked better on stage. It is false, and worse, it is self defeating: a concentrated curve
pins the marginal price inside its own bounds, so the book would quote near parity even with the enormous
output balance shipped, and the removal test would stop biting. Running without `0x92` has to overstate depth
by a factor of forty, and a range invented for the demo would have quietly bought that away.

`Decay` in the program stack. Its NatSpec announces a quote versus swap divergence, and that invariant is the
one thing we claim structurally.

Scaling to three positions, flow driven range recentering, and a three strategy cascade. Each multiplies the
setup that can fail at four in the morning, for a shock that is already whole at two.

Chasing green on additivity and monotonicity. The sponsor's own `TESTING.md` skips both on comparable
instruction combinations, with literal `why it didn't fail?` TODOs. Documenting them as skipped with the
citation is the correct answer and costs ten minutes.

## Positioning

Two teams on site are building solvency floors. This project runs in the opposite direction: it does not stop
the maker from promising more than the wallet holds, it wires the funding source into the same transaction so
the promise is honourable. Never open a conversation on the word oversubscription.

Uniswap shipped DualPool on 2026-07-23, a v4 hook keeping funds in ERC-4626 vaults and pulling exactly what a
swap needs at execution time. That is this mechanism, at their place, with their name on it, and a judge will
make the association within ten seconds. The difference is direction: DualPool brings idle capital into a
Uniswap pool for a Uniswap swap, this takes capital out of a Uniswap position to settle a book on another
protocol. Say it before they do, and use it: it proves the pattern is one Uniswap Labs audited and shipped
with 150 million dollars behind it.
