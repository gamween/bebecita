# Demo script

Three minutes, three screens, and the judges see both legs inside one transaction.

Left: the network panel, raw Uniswap API requests and responses with `x-ratelimit-remaining`. Middle: the
terminal. Right: the position on sepolia.etherscan.io and on the Uniswap interface.

Everything is on public Ethereum Sepolia. There is no fork and nothing is mocked, which is the silent answer
to the only question that kills a hackathon demo.

Nothing in this script is conditional. Every beat below describes something that exists and has run. If a beat
cannot be performed on the day, cut it rather than hedge it out loud.

## Before recording, and this is required

```bash
yarn inventory                # what the book is holding right now
yarn rebalance                # trade the float home, both sides back into the position
yarn inventory                # confirm the float is back to near nothing
yarn demo:reset               # a fresh salt, so the fill can be run live
```

The opening beat says the maker's wallet holds almost nothing. That is a claim about the vault's ERC20
balances, and it is only true right after a rebalance. This book is one directional: every fill is paid in
bBRAVO and pays out bALPHA, so the vault accumulates bBRAVO fill by fill and the opening claim quietly stops
being true. Read at block 11351549, the vault held **6,401.95 bBRAVO** and 18.24 bALPHA, which is not almost
nothing and would be the first thing a judge screenshots.

`yarn rebalance` sells the surplus and puts both sides back in the position. The last one took the float from
21,859.61 bBRAVO and 2.07 bALPHA to 35.73 and 0.93, and the position from 92,140.39 of liquidity to
102,473.62. Run it, then read the figure off `yarn inventory` and say that number on camera rather than the
one written here, because this one will be stale by the time it is read.

`yarn negative-moment` refuses to be impressive against a fat float and says so: if the quote it ships is
smaller than the vault's balance, the swap would succeed and it prints a warning telling you to rebalance
first. That is the same reason, enforced by the script.

## 0:00 to 0:20, the setup

"This is a real Uniswap v4 liquidity position on Sepolia, opened through the Uniswap API. The wallet that
holds it contains almost no free tokens. And that same wallet is quoting an order book on 1inch Aqua, on many
times its float."

Show the vault's balance, near zero. Show the quoted depth. Let the contrast sit for a beat.

## 0:20 to 0:50, the negative moment, side by side

This is the passage that makes the instruction exist, and it runs as a split screen rather than in sequence so
the judges compare two rectangles instead of remembering one.

Both sides run on our router. Same curve, `0x51` with the same bounds, the same asymmetric shipped amounts,
hookless on the left. The only difference between the two rectangles is one instruction.

Left, red: the book `yarn negative-moment` ships. The program is `[0x51 concentrate][0x02 salt]` and nothing
else, so there is no `0x92` to bring the quote back down and no maker hook to unwind anything. The quote
succeeds and prints how many times over the maker's actual float it just promised. The swap dies at
`Aqua.sol:68`, on a `safeTransferFrom` out of a wallet holding almost nothing. Walk the trace down to that
line.

Right, green: the live book, same router, same curve, plus `0x92`. `Swapped`.

No narration between them, just a finger moving across. Then one sentence: "same router, same curve, same
bounds. One instruction of difference."

Holding the router constant is the stronger experiment, and saying so out loud is worth ten seconds. Two
routers would have been a confounding variable in a demo whose entire claim is that one instruction is doing
the work.

That failure is also an executable assertion, `test_WithoutInstruction_QuotePassesAndSwapReverts`, so it can be
rerun on demand if anyone doubts it.

**Offer this if asked, do not lead with it.** The obvious version of this beat was to run the left rectangle on
1inch's own `AquaSwapVMRouter`, deployed on Sepolia at `0x8fdd04dbf6111437b44bbca99c28882434e0958f`. It does
not work. That deployment computes `hash(order)` correctly and Aqua registers a strategy shipped under it
correctly, but `quote()` reverts with completely empty return data for any order built against the `swap-vm`
commit this project pins, including an order that was never shipped, where a router built from the published
source reverts with `SafeBalancesForTokenNotInActiveStrategy` and its four arguments. Its runtime bytecode is a
different size from that source too. So the deployed official router is an older or divergent build. That is
in `FEEDBACK.md` with the repro, and it is a genuine finding rather than a thing that went wrong: it was found
by trying to run our own book through their router as a control.

## 0:50 to 1:20, the instruction

Turn `0x92` back on. Same quote, same clip. The panel shows three numbers: the wallet float, the withdrawable
value of the position read on chain, and the haircut. The quote now returns a smaller and honest figure.

"We never lie upward. We only clamp downward, and the price now carries the real cost of getting out of the
position."

URC-3 lands here, ten seconds. `supportsInterface` returns true, then `getReserves` and `getEffectiveLiquidity`
side by side, both reading the position's real content per token off the pool price rather than assuming the
two sides are equal. Point at the gap between the two sides: at block 11351549 the vault reports 117,000.00
bBRAVO and 89,438.13 bALPHA of reserves against 32,668.99 and 21,255.47 of effective liquidity. Those are not
the same number on the two sides, and that is the whole point.

Ten more seconds, and worth taking, because it is the only place in the demo where the taker is the adversary:
`test_Attack_WouldHavePassedTheFirstThreeGuards`. One payload unwinds the whole per fill cap, pays the vault
exactly what the fill owes and keeps the rest. Three of the four original guards say yes. The fifth prices what
came out of the position and says no.

## 1:20 to 2:20, the fill, where both legs become visible

Press **Run a fill**, from the dashboard, with a wallet connected. On the left, live: `POST /lp/decrease` goes
out to `liquidity.api.uniswap.org` and comes back with its calldata, then `POST /lp/increase`. "Those two
calldatas just left this browser tab. They are going into two slices of the taker traits."

Worth saying out loud once, because a judge will ask: there is no backend. The taker traits are encoded in
TypeScript, the swap is signed by the connected wallet, and the only other thing running is a proxy holding the
Uniswap key, which is Vite middleware locally and a serverless function in production. `TestERC20.mint` is
public, so hand them the laptop, or the URL, and let them fill it themselves from their own wallet.

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

The last fill is the number to have on screen if the live one is slow:
[`0xfa8e60eb…`](https://sepolia.etherscan.io/tx/0xfa8e60eb930b9617455ceeaf36b23bb788532738d1944358c5d5ee59d7a8a704),
1,000 bBRAVO in, 912.676854023977327256 bALPHA out, 340,599 gas, one hash carrying an unwind, a swap and a
redeposit.

## 2:40 to 3:00, the close

Claim the fees the position accrued while it was quoting.

"The same capital earned Uniswap LP fees and market making spread, on the same dollars, in the same hour. The
Aqua whitepaper says 85 to 97 percent of AMM liquidity sits idle. We are not denouncing that, we are putting
it to work twice."

## Survival rules

Rebalance before recording. It is the first section of this file for a reason: the opening line of the demo is
false without it.

Re-salt the order between full runs. A strategy hash can only be shipped once, ever, because `Aqua.ship`
requires `tokensCount == 0` and `dock` sets it to `0xff` permanently. The reset script does this; if a rerun
fails with `StrategiesMustBeImmutable`, that is what happened. `yarn negative-moment` re-ships from
`deployments.vault` on every run and picks its own salt, so it can be run as often as the rehearsal needs.

Have the transaction hashes from a previous successful run open in a tab. A live demo that depends on a public
RPC responding on time is a demo with a single point of failure.

Have the deployed URL open too, https://bebecita-aqua.vercel.app, so a laptop
failure costs the demo nothing.

Never open on the word oversubscription. Two other teams here are positioned on solvency floors. Open on the
funding source.
