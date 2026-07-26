# Submission checklist

Everything that has to be true before the deadline, and who does it. Machine checkable items carry the
command that checks them.

Counts in this file are exact as of **2026-07-26** and each one carries the command that re-derives it, because
a number written once goes stale and a number with its own command does not.

## 1inch, Build an Aqua App, 5000

| Requirement | Status | How it is proven |
|---|---|---|
| Official Aqua/SwapVM contracts used | done | `cast call <router> "AQUA()(address)"` returns `0x499943E74FB0cE105688beeE8Ef2ABec5D936d31`, the canonical address, whose bytecode on Sepolia is identical to Base |
| Redeployment of a modified SwapVM | done | `BebecitaRouter is Simulator, SwapVM, BebecitaOpcodes`, one added instruction and three rewired ones, not a line of the sponsor's source modified |
| On-chain execution of token transfers shown in the demo | done | seventeen real fills on public Sepolia, latest `0xfa8e60eb930b9617455ceeaf36b23bb788532738d1944358c5d5ee59d7a8a704`, which is `lastFill.txHash` in `deployments/sepolia.json` |
| Proper git commit history, no single-commit entry | done | 75 commits on `main` across 20 merged pull requests, linear, milestone by milestone. `git rev-list --count origin/main` and `gh pr list --state merged --limit 100 --json number --jq 'length'` |
| Uses SwapVM, scored higher | done | custom instruction `0x92` in the reserved slot of the balances tuning bank, asserted by test rather than claimed |

## Uniswap, Best Uniswap API Integration, 7000

| Requirement | Status | How it is proven |
|---|---|---|
| Public GitHub repository, open source | done | github.com/gamween/bebecita, MIT |
| Uniswap API with a valid Developer Platform key | done | `x-api-key` on every LP call, `yarn gate0` proves the key live |
| API powers core functionality | done | liquidity provision, literally: `/lp/decrease` and `/lp/increase` calldata executed on-chain inside every fill |
| FEEDBACK.md | done | 15 reproducible findings, 11 Uniswap and 4 1inch, each with a repro and a suggestion. `grep -c '^### ' FEEDBACK.md` |
| Developer Feedback form submitted, with the link to FEEDBACK.md | **TODO, Fianso** | developers.uniswap.org/hackathon-feedback |
| README identifies the relevant contracts and code lines | done | `SwapVM.sol:310-314`, `:321`, `Aqua.sol:63-70` in the README and on the diagram arrow |

## Shared

| Item | Status |
|---|---|
| Contracts verified on Etherscan | done, all four |
| App deployed and public | done, https://bebecita-aqua.vercel.app |
| Both serverless proxies live in production | done, see the two commands below |
| Demo video, 2 to 4 minutes | **TODO, Fianso**, script ready in `docs/DEMO.md` |
| Demo replayable live | done, `yarn demo:reset` then `yarn fill`, run twice consecutively for real |
| Art direction pass on the frontend | **TODO, Fianso** |

The deployment is a submission artefact rather than a convenience. A judge who does not want to clone anything
opens that URL, connects a wallet, mints, approves and fills against this maker. Nothing about the security
model depends on where the tab is served from, which is the point of the vault's guards.

## The three things only Fianso can do

Submit the Uniswap Developer Feedback form with the link to `FEEDBACK.md`. It is written in the qualifying
requirements, not in the nice to have list, and a strong project without it gets audited rather than judged.

Record the video. The script in `docs/DEMO.md` is minute by minute and the negative moment is the passage that
sells the instruction, so it comes before anything that works.

Revise the art direction.

## Before hitting submit

```bash
yarn gate0                                              # six live checks
forge test --match-path contracts/test/Bebecita.t.sol   # never bare forge test, via_ir costs 3 min 49
forge test --match-path contracts/test/TakerTraits.t.sol
forge test --match-path contracts/test/LiquidityAmounts.t.sol
cd app && yarn build                                    # never yarn --cwd app build on this machine
yarn rebalance                                          # the maker's float back to near zero, see docs/DEMO.md
yarn demo:reset && yarn fill                            # one green fill, from a clean slate
```

`yarn test` runs the three suites in that order and totals 48 tests.

Check the production deployment answers on both proxies, because a static build with dead API routes is a
worse artefact than no deployment at all:

```bash
curl -sD - -o /dev/null -X POST \
  https://bebecita-aqua.vercel.app/api/uniswap/lp/pool_info \
  -H 'content-type: application/json' \
  -d '{"chainId":11155111,"protocol":"V4","poolParameters":{"tokenAddressA":"0x0128Ac6B5E3364b022e55A0cf9c0cb4987B3B20f","tokenAddressB":"0xdB41CB0A2EEFF8Ed53Ef019D4C9826744f500B7F","fee":3000,"tickSpacing":60,"hookAddress":"0x0000000000000000000000000000000000000000"}}'
# 200, x-bebecita-api-key: present, x-bebecita-upstream: https://liquidity.api.uniswap.org/lp/pool_info

curl -s -X POST https://bebecita-aqua.vercel.app/api/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
# {"jsonrpc":"2.0","result":"0x...","id":1}
```

Then check that `deployments/sepolia.json` matches what the README claims, because that file is the source of
truth for every address the app and the solver read at runtime. Four values have to agree, and they are the
four a judge can check in ten seconds:

```bash
python3 - <<'EOF'
import json
d = json.load(open('deployments/sepolia.json'))
readme = open('README.md').read()
want = {
    'vault': d['vault'],
    'router': d['router'],
    'strategy': d['strategy']['orderHash'],
    'last fill': d['lastFill']['txHash'],
}
bad = [f'{k} {v} MISSING from README' for k, v in want.items() if v.lower() not in readme.lower()]
if d['previousVault']['address'].lower() in readme.lower() and 'redeploy' not in readme.lower():
    bad.append('previous vault named without saying it was replaced')
print('\n'.join(bad) if bad else 'README matches deployments/sepolia.json')
EOF
```

The README names the vault, the router, the live strategy hash and the latest fill hash, and no other vault or
strategy hash appears in it as current. The superseded vault `0xE703F509ba1bF70BcFa4957a7090e73B627dE76a` is
named once, in the paragraph explaining why it was replaced, and `deployments/sepolia.json` carries it under
`previousVault` with the same explanation. That is the only place either document may name it.
