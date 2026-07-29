# Submission record

What was submitted to ETHGlobal Lisbon 2026, on both tracks, and what was not. This file was a checklist
before the deadline and is kept as the record afterwards, with the same rows and their outcome instead of
their owner.

Two rows are open, and they are written as open. A public repository that overstates its own status is worse
than one that admits a gap, and a reader who checks either of these finds out in a minute regardless.

Counts here carry the command that re-derives them rather than a date, because a number written once goes
stale and a number with its own command does not. The commit and pull request counts are deliberately absent:
this file lands through a pull request itself, so any figure it quoted about its own repository would be wrong
the moment it landed. `git rev-list --count origin/main` and
`gh pr list --state merged --limit 100 --json number --jq 'length'` answer both.

## 1inch, Build an Aqua App, 5000

| Requirement | Outcome | How it is proven |
|---|---|---|
| Official Aqua/SwapVM contracts used | met | `cast call <router> "AQUA()(address)"` returns `0x499943E74FB0cE105688beeE8Ef2ABec5D936d31`, the canonical address, whose bytecode on Sepolia is identical to Base |
| Redeployment of a modified SwapVM | met | `BebecitaRouter is Simulator, SwapVM, BebecitaOpcodes`, one added instruction and three rewired ones, not a line of the sponsor's source modified |
| On-chain execution of token transfers shown in the demo | met | nineteen real fills on public Sepolia, from three distinct taker addresses. The `cast logs` command under [what a fill costs](../README.md#what-a-fill-costs) enumerates them from the router's own `Swapped` topic |
| Proper git commit history, no single-commit entry | met | linear history, milestone by milestone, every task on its own branch through a pull request. `git rev-list --count origin/main` and `gh pr list --state merged --limit 100 --json number --jq 'length'` |
| Uses SwapVM, scored higher | met | custom instruction `0x92` in the reserved slot of the balances tuning bank, asserted by test rather than claimed |

## Uniswap, Best Uniswap API Integration, 7000

| Requirement | Outcome | How it is proven |
|---|---|---|
| Public GitHub repository, open source | met | github.com/gamween/bebecita, MIT |
| Uniswap API with a valid Developer Platform key | met | `x-api-key` on every LP call, `yarn gate0` proves the key live |
| API powers core functionality | met | liquidity provision, literally: `/lp/decrease` and `/lp/increase` calldata executed on-chain inside every fill |
| FEEDBACK.md | met | 16 reproducible findings, 11 Uniswap and 5 1inch, each with a repro and a suggestion. `grep -c '^### ' FEEDBACK.md` |
| Developer Feedback form submitted, with the link to FEEDBACK.md | **not submitted** | the form at developers.uniswap.org/hackathon-feedback was never filed. The findings themselves are public in `FEEDBACK.md`, sixteen of them, but the requirement asked for the form and the form is where they were meant to reach Uniswap |
| README identifies the relevant contracts and code lines | met | `SwapVM.sol:310-314`, `:321`, `Aqua.sol:63-70` in the README and on the diagram arrow |

## Shared

| Item | Outcome |
|---|---|
| Contracts verified on Etherscan | met, all four. `getsourcecode` on the Etherscan API returns `BebecitaRouter`, `BebecitaVault` and `TestERC20` twice |
| App deployed and public | met, https://bebecita-aqua.vercel.app |
| Both serverless proxies live in production | met, see the two commands below |
| Demo replayable live | met, `yarn demo:reset` then `yarn fill`, run twice consecutively for real |
| Art direction pass on the frontend | met, done by Sanka. Light theme, hero orbit, serif display, scrolling marquee |
| Demo video, 2 to 4 minutes | **not recorded**. The script in `docs/DEMO.md` is minute by minute and every beat in it describes something that exists and has run, but no take was ever made |

The deployment is a submission artefact rather than a convenience. A judge who does not want to clone anything
opens that URL, connects a wallet, mints, approves and fills against this maker. Nothing about the security
model depends on where the tab is served from, which is the point of the vault's guards, and three of the
nineteen settled fills were signed by a wallet that is not the deployer's.

## The checks, and they still run

```bash
yarn gate0                                              # six live checks
forge test --match-path contracts/test/Bebecita.t.sol   # never bare forge test, via_ir costs 3 min 49
forge test --match-path contracts/test/TakerTraits.t.sol
forge test --match-path contracts/test/LiquidityAmounts.t.sol
cd app && yarn build                                    # never yarn --cwd app build on this machine
yarn rebalance                                          # the maker's float back to near zero, see docs/DEMO.md
yarn demo:reset && yarn fill                            # one green fill, from a clean slate
```

`yarn test` runs the three suites in that order and totals 53 tests: 34 in `Bebecita.t.sol`, 16 in
`LiquidityAmounts.t.sol` and 3 in `TakerTraits.t.sol`. The count is the sum of the three `Ran 1 test suite`
lines, so it re-derives itself every run.

The production deployment answers on both proxies. A static build with dead API routes is a worse artefact
than no deployment at all, so this is worth re-running rather than trusting:

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

And `deployments/sepolia.json` still matches what the README claims, because that file is the source of truth
for every address the app and the solver read at runtime. Four values have to agree, and they are the four a
reader can check in ten seconds:

```bash
python3 - <<'EOF'
import json
d = json.load(open('deployments/sepolia.json'))
readme = open('README.md').read()
want = {
    'vault': d['vault'],
    'router': d['router'],
    'strategy': d['strategy']['orderHash'],
    'recorded fill': d['lastFill']['txHash'],
}
bad = [f'{k} {v} MISSING from README' for k, v in want.items() if v.lower() not in readme.lower()]
if d['previousVault']['address'].lower() in readme.lower() and 'redeploy' not in readme.lower():
    bad.append('previous vault named without saying it was replaced')
print('\n'.join(bad) if bad else 'README matches deployments/sepolia.json')
EOF
```

The README names the vault, the router, the live strategy hash and the fill the record carries under
`lastFill`, and no other vault or strategy hash appears in it as current. Fills placed from the dashboard are
signed by a connected wallet and write nothing, so `lastFill` names the last fill `yarn fill` ran rather than
the last fill that settled; the README says which is which and links both. The superseded vault
`0xE703F509ba1bF70BcFa4957a7090e73B627dE76a` is named once, in the paragraph explaining why it was replaced,
and `deployments/sepolia.json` carries it under `previousVault` with the same explanation. That is the only
place either document may name it.
