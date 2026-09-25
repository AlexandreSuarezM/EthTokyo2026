# HITL Attest

Human-in-the-loop accountability for AI-written code, built for ETHGlobal Tokyo 2026:
**World ID** (one human, one account) + **validation receipts** (who approved which output, no
token) + a **penalty token** minted only when forensics proves a validation wrong: soulbound,
escalating, capped and fading, with three stages (published score, no AI access, banned).

Read [DESIGN.md](DESIGN.md) for how it works and [AUDIT.md](AUDIT.md) for the security review.
Open source under the [MIT license](LICENSE).

## Layout

```
contracts/          Foundry project (deps in contracts/lib are git submodules)
  src/              HumanRegistry, PermissionRegistry, ValidationReceipts, PenaltyLedger, WorldIDVerifier
  test/             unit, fuzz and invariant tests (75)
app/                Next.js (App Router, TypeScript): UI, API routes, agent, attester, relayer
scripts/            deployment and ENS setup
config/             deployed addresses per chain (<chainId>.json)
environments/       rule presets: policy, receipt windows, penalty rules, repos, presets, fees
legacy/             original Zone 1 orchestrator + end-to-end local demo
docs/               DECISIONS, RULES, DEBRIEF, LIMITS, BUILD_PLAN
```

## Run

Requires Foundry (`forge`, `anvil`) and Node 22+.

```bash
git clone --recurse-submodules https://github.com/AlexandreSuarezM/EthTokyo2026.git
# already cloned? git submodule update --init

cd contracts && forge build && forge test     # 75 tests: unit, fuzz, invariants

cd ../app && cp ../.env.example .env.local    # fill in values
npm install && npm run dev

cd ../legacy && npm install
node demo.js                                  # end-to-end on a local anvil chain (needs forge build)
node check-envs.js                            # verify all environment presets
```

## Deploy to Sepolia

[contracts/script/Deploy.s.sol](contracts/script/Deploy.s.sol) deploys `HumanRegistry`, `PermissionRegistry`,
`ValidationReceipts` and `PenaltyLedger`, wires their roles like `legacy/src/contracts.js`, turns on
attester mode, applies an environment preset, and writes the addresses to `config/<chainId>.json`.
Deploying costs about 13.7M gas (≈0.03 Sepolia ETH at 2 gwei).

One-time setup: store the deployer key in an encrypted Foundry keystore (not in `.env`) and fund it with Sepolia ETH.

```bash
cast wallet import deployer --interactive
```

Deploy, from `contracts/`:

```bash
export SEPOLIA_RPC_URL=<your Sepolia RPC URL>
export ATTESTER=<address of the backend attester key (ATTESTER_PRIVATE_KEY)>

# 1. dry run on a fork: simulates everything, writes config/11155111.dry-run.json
forge script script/Deploy.s.sol --fork-url $SEPOLIA_RPC_URL

# 2. deploy: writes config/11155111.json
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --account deployer --broadcast
```

Optional variables:

| Variable | Default | Meaning |
|---|---|---|
| `HITL_ENV` | `team-default` | preset in `environments/` |
| `ADMIN` | the deployer | final admin of all four contracts (use a Safe); the deployer renounces its admin role |
| `OPERATOR` | the deployer | orchestrator/relayer address that consumes AI quotas |
| `FEE_TREASURY` | `ADMIN` | fee recipient, when the preset has fees |
| `DEPLOY_WORLD_ID_VERIFIER` | `false` | also deploy the World ID 3.x on-chain adapter; then set `WORLD_ID_ROUTER`, `WORLD_APP_ID`, `WORLD_ACTION` |

The config file is written while the script runs, before forge sends the transactions. Only commit
`config/11155111.json` after forge prints `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`. If the broadcast
stops partway, finish it with `--resume` instead of starting over.

Ruling roles (forensics, appeals, evaluator) are not granted at deploy time: they must go to enrolled humans.

## Secrets

Real values live only in `app/.env.local` (git-ignored). [.env.example](.env.example) lists every variable, with no values.
Commits are scanned with [gitleaks](https://github.com/gitleaks/gitleaks) locally and in CI. Enable the hook once:

```bash
pip install pre-commit && pre-commit install
```

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml): gitleaks scan → `forge build` + `forge test` → app `npm ci`, lint, typecheck, test.
