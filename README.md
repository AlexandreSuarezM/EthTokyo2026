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
  test/             unit, fuzz and invariant tests (55)
app/                Next.js (App Router, TypeScript): UI, API routes, agent, attester, relayer
scripts/            deployment and ENS setup
config/             per-network addresses (<network>.json)
environments/       rule presets: policy, receipt windows, penalty rules, repos, presets, fees
legacy/             original Zone 1 orchestrator + end-to-end local demo
docs/               DECISIONS, RULES, DEBRIEF, LIMITS, BUILD_PLAN
```

## Run

Requires Foundry (`forge`, `anvil`) and Node 22+.

```bash
git clone --recurse-submodules https://github.com/AlexandreSuarezM/EthTokyo2026.git
# already cloned? git submodule update --init

cd contracts && forge build && forge test     # 55 tests: unit, fuzz, invariants

cd ../app && cp ../.env.example .env.local    # fill in values
npm install && npm run dev

cd ../legacy && npm install
node demo.js                                  # end-to-end on a local anvil chain (needs forge build)
node check-envs.js                            # verify all environment presets
```

## Secrets

Real values live only in `app/.env.local` (git-ignored). [.env.example](.env.example) lists every variable, with no values.
Commits are scanned with [gitleaks](https://github.com/gitleaks/gitleaks) locally and in CI. Enable the hook once:

```bash
pip install pre-commit && pre-commit install
```

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml): gitleaks scan → `forge build` + `forge test` → app `npm ci`, lint, typecheck, test.
