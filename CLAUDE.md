# CLAUDE.md — project memory for Claude Code

## What this project is
Human-in-the-loop accountability for AI-written code, built for ETHGlobal Tokyo 2026
(World: IDKit + World ID for Agents; ENS: ENSv2 on Sepolia).

1. Users enroll with World ID (one human = one account).
2. A user prompts an AI agent; the agent proposes a change; the validator accepts, or denies with new input.
3. On accept, the validator is verified by World ID **at that moment** and a **receipt** is recorded (no token).
4. Later, forensics audits the receipt. If the validation was wrong (after due process),
   a **soulbound penalty token** is minted to the validator and their score rises.
5. Score → stage: 1 = score published on ENS, 2 = no AI access, 3 = banned. The score fades over time.

Read `DESIGN.md` (model), `AUDIT.md` (security findings + trust assumptions), `docs/BUILD_PLAN.md` (tasks).

## Layout (target monorepo)
- `contracts/` Foundry: `HumanRegistry`, `PermissionRegistry`, `ValidationReceipts`, `PenaltyLedger`, `WorldIDVerifier`
  (deps in `contracts/lib` are git submodules: clone with `--recurse-submodules`)
- `legacy/` the original Zone 1 orchestrator + local demo (reads `contracts/out`)
- `app/` Next.js (App Router, TypeScript): UI, API routes, agent, attester, relayer
- `scripts/` deployment + ENS setup
- `config/<network>.json` addresses (never hard-code addresses in code)
- `environments/*.json` rule presets
- `docs/` DECISIONS, RULES, TRUST, DEBRIEF, LIMITS, BUILD_PLAN

## Commands
- `cd contracts && forge build && forge test` (must stay green; currently 55 tests)
- `cd app && npm run lint && npm run typecheck && npm test`
- Local chain demo (legacy orchestrator): `cd contracts && forge build && cd ../legacy && npm install && node demo.js`

## Invariants you must never break (from AUDIT.md)
- No token is minted at validation. Penalties are minted only by `ValidationReceipts` (MINTER_ROLE)
  after a forensics ruling on a real receipt, with evidence, inside the liability window, after due process.
- Anyone who rules (forensics, appeals, evaluator) must be an **enrolled human**; compare humans, never addresses.
  Nobody rules on their own receipt; the appeal reviewer is a different human from the judge and the validator.
- Penalty tokens are non-transferable and non-burnable. Use `_mint`, never `_safeMint`, for penalties.
- The score is capped; decay rates are snapshotted per account; config changes are never retroactive on decay.
- External calls to publishers/mirrors are `try/catch` with a gas cap and can never block a penalty.
- Fees are paid by `msg.sender`, never pulled from a stored address.
- Checks → effects → interactions. Every new finding gets a regression test named after it.

## Security rules for app code
- World ID: RP signing key, attester key and relayer key are **server-only**. Never import them in client components.
- Verify every World ID result on the server (`POST https://developer.world.org/api/v4/verify/{rp_id}`),
  check `environment`, check the bound action/signal, enforce one-time use (nullifier/approval key).
- Never trust LLM-generated tool inputs: recompute the commit hash from the repository before any protected action.
- `.env*` is git-ignored; only `.env.example` (names, no values) is committed.

## Working agreement
- Read the official docs linked in the task before writing integration code; if the docs disagree with
  this file or the task, stop and report the difference instead of guessing.
- Append integration friction, missing docs and time-to-first-success to `docs/DEBRIEF.md` as you go
  (it is a prize requirement).
- Small commits, one task per branch. Don't edit files owned by another lane (see BUILD_PLAN lanes).
