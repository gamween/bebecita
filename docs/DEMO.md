# Demo script

Three minutes, three screens, and the judges see both legs inside one transaction.

Left: the network panel, raw Uniswap API requests and responses with `x-ratelimit-remaining`. Middle: the
terminal. Right: the position on sepolia.etherscan.io and on the Uniswap interface.

Everything is on public Ethereum Sepolia. There is no fork and nothing is mocked, which is the silent answer
to the only question that kills a hackathon demo.

## 0:00 to 0:20, the setup

"This is a real Uniswap v4 liquidity position on Sepolia, opened through the Uniswap API. The wallet that
holds it contains almost no free tokens. And that same wallet is quoting an order book on 1inch Aqua, on ten
times its float."

Show the vault's balance, near zero. Show the quoted depth. Let the contrast sit for a beat.

## 0:20 to 0:50, the negative moment, side by side

This is the passage that makes the instruction exist, and it runs as a split screen rather than in sequence so
the judges compare two rectangles instead of remembering one.

Left, red: the official 1inch `AquaSwapVMRouter`, already deployed on Sepolia at
`0x8fdd04dbf6111437b44bbca99c28882434e0958f`, running the same program without `0x92`. The quote succeeds. The
swap reverts. Walk the trace down to `Aqua.sol:63-70` and the `safeTransferFrom` on an insufficient balance.

Right, green: our router, same program plus one instruction. `Swapped`.

No narration between them, just a finger moving across. Then one sentence: "on the left, your router as you
deployed it. On the right, the same thing plus one else-if."

That failure is also an executable assertion, `test_WithoutInstruction_QuotePassesAndSwapReverts`, so it can be
rerun on demand if anyone doubts it.

## 0:50 to 1:20, the instruction

Turn `0x92` back on. Same quote, same clip. The panel shows three numbers: the wallet float, the withdrawable
value of the position read on chain, and the haircut. The quote now returns a smaller and honest figure.

"We never lie upward. We only clamp downward, and the price now carries the real cost of getting out of the
position."

If URC-3 is wired, this is where it lands, ten seconds: `supportsInterface` returns true, then `getReserves`
and `getEffectiveLiquidity` side by side, both reading the position's real content per token off the pool
price rather than assuming the two sides are equal.

Ten more seconds, and worth taking, because it is the only place in the demo where the maker is the adversary:
`test_Attack_WouldHavePassedTheFirstThreeGuards`. One payload unwinds the whole per fill cap, pays the vault
exactly what the fill owes and keeps the rest. Three of the four original guards say yes. The fifth prices what
came out of the position and says no.

## 1:20 to 2:20, the fill, where both legs become visible

Press **Run a fill**, from the dashboard, with a wallet connected. On the left, live: `POST /lp/decrease` goes
out to `liquidity.api.uniswap.org` and comes back with its calldata, then `POST /lp/increase`. "Those two
calldatas just left this browser tab. They are going into two slices of the taker traits."

Worth saying out loud once, because a judge will ask: there is no backend. The taker traits are encoded in
TypeScript, the swap is signed by the connected wallet, and the only thing running besides the tab is the dev
server holding the Uniswap key. `TestERC20.mint` is public, so hand them the laptop and let them fill it
themselves from their own wallet.

In the middle, one transaction. Walk the trace slowly:

1. `runLoop`, instruction `0x92` reads the position and clamps.
2. `preTransferOut`, the vault executes the decrease against the v4 PositionManager. The position unwinds.
3. `AQUA.pull`, one instruction later. The taker is paid.
4. `AQUA.push`, the taker's input reaches the vault.
5. `postTransferIn`, the vault redeposits.

Point at steps 2 and 3: "`SwapVM.sol:310` and `:321`. `preTransferOut` is the last maker controlled point
before the tokens leave, in both transfer orders. The only thing that can run in between is `:316-319`, a
callback the taker has to ask for and that runs the taker's own code, which is why our guards check balances
instead of trusting the order. We found all of that by reading your source."

Open the transaction on sepolia.etherscan.io. Two PositionManager calls and a `Swapped` event, one hash.

## 2:20 to 2:40, not a fluke

Second fill, same loop. The position's liquidity moved between the two, and the quote changed accordingly,
because the instruction rereads the position every time.

If the two fills in one transaction task landed: one hash, two `Swapped` events, one tokenId touched. That is
the strongest ten seconds in the demo, and no off-chain keeper can produce it, because it would be racing the
solver and losing.

## 2:40 to 3:00, the close

Claim the fees the position accrued while it was quoting.

"The same capital earned Uniswap LP fees and market making spread, on the same dollars, in the same hour. The
Aqua whitepaper says 85 to 97 percent of AMM liquidity sits idle. We are not denouncing that, we are putting
it to work twice."

## Survival rules

Re-salt the order between full runs. A strategy hash can only be shipped once, ever, because `Aqua.ship`
requires `tokensCount == 0` and `dock` sets it to `0xff` permanently. The reset script does this; if a rerun
fails with `StrategiesMustBeImmutable`, that is what happened.

Have the transaction hashes from a previous successful run open in a tab. A live demo that depends on a public
RPC responding on time is a demo with a single point of failure.

Never open on the word oversubscription. Two other teams here are positioned on solvency floors. Open on the
funding source.
