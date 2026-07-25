# Submission checklist

Everything that has to be true before the deadline, and who does it. Machine checkable items carry the
command that checks them.

## 1inch, Build an Aqua App, 5000

| Requirement | Status | How it is proven |
|---|---|---|
| Official Aqua/SwapVM contracts used | done | `cast call <router> "AQUA()(address)"` returns `0x499943E74FB0cE105688beeE8Ef2ABec5D936d31`, the canonical address, whose bytecode on Sepolia is identical to Base |
| Redeployment of a modified SwapVM | done | `BebecitaRouter is Simulator, SwapVM, BebecitaOpcodes`, one added instruction and three rewired ones, not a line of the sponsor's source modified |
| On-chain execution of token transfers shown in the demo | done | six real fills on public Sepolia, latest `0x5f36e98d5d2698800b40a54e1c164ca5511bcd4af7ed9e8c0918a0c0a66c64db` |
| Proper git commit history, no single-commit entry | done | 31 commits across 7 pull requests, linear, milestone by milestone |
| Uses SwapVM, scored higher | done | custom instruction `0x92` in the reserved slot of the balances tuning bank, asserted by test rather than claimed |

## Uniswap, Best Uniswap API Integration, 7000

| Requirement | Status | How it is proven |
|---|---|---|
| Public GitHub repository, open source | done | github.com/gamween/bebecita, MIT |
| Uniswap API with a valid Developer Platform key | done | `x-api-key` on every LP call, `yarn gate0` proves the key live |
| API powers core functionality | done | liquidity provision, literally: `/lp/decrease` and `/lp/increase` calldata executed on-chain inside every fill |
| FEEDBACK.md | done | 14 reproducible findings, 5 Uniswap and 9 1inch, each with a repro and a suggestion |
| Developer Feedback form submitted, with the link to FEEDBACK.md | **TODO, Fianso** | developers.uniswap.org/hackathon-feedback |
| README identifies the relevant contracts and code lines | done | `SwapVM.sol:310-314`, `:321`, `Aqua.sol:63-70` in the README and on the diagram arrow |

## Shared

| Item | Status |
|---|---|
| Contracts verified on Etherscan | done, all four |
| Demo video, 2 to 4 minutes | **TODO, Fianso**, script ready in `docs/DEMO.md` |
| Demo replayable live | done, `yarn demo:reset` then `yarn fill`, run twice consecutively for real |
| Art direction pass on the frontend | **TODO, Fianso** |

## The three things only Fianso can do

Submit the Uniswap Developer Feedback form with the link to `FEEDBACK.md`. It is written in the qualifying
requirements, not in the nice to have list, and a strong project without it gets audited rather than judged.

Record the video. The script in `docs/DEMO.md` is minute by minute and the negative moment is the passage that
sells the instruction, so it comes before anything that works.

Revise the art direction.

## Before hitting submit

```bash
yarn gate0                                          # six live checks
forge test --match-path contracts/test/Bebecita.t.sol   # never bare forge test, via_ir costs 3 min 49
cd app && yarn build                                # never yarn --cwd app build on this machine
yarn demo:reset && yarn fill                        # one green fill, from a clean slate
```

Then check that `deployments/sepolia.json` matches what the README claims, because that file is the source of
truth for every address the app and the solver read at runtime.
