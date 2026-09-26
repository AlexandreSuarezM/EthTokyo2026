# CLAUDE.md — project memory for Claude Code

## What this project is
Human-in-the-loop accountability for AI-written code, built for ETHGlobal Tokyo 2026
(target prizes: World IDKit and World ID for Agents; ENS is deferred, see "Current scope").

1. Users enroll with World ID (one human = one account).
2. A user prompts an AI agent; the agent proposes a change; the validator accepts, or denies with new input.
3. On accept, the validator is verified by World ID **at that moment** and a **receipt** is recorded (no token).
4. Later, forensics audits the receipt. If the validation was wrong (after due process),
   a **soulbound penalty token** is minted to the validator and their score rises.
5. Score → stage: 1 = score published, 2 = no AI access, 3 = banned. The score fades over time.

Read `DESIGN.md` (model), `AUDIT.md` (security findings + trust assumptions), `docs/BUILD_PLAN.md` (tasks),
`docs/STATUS.md` (deadline, what's done, today's order).

## Current scope
- **Single-user demo (scope change 2026-09-26).** One person plays the **validator** (the human pressing
  Approve / Reject). The **oracle** is the server that generated the code and knows if it was wrong: it
  penalizes a wrong approval on-chain through `ValidationReceipts.oraclePenalize` (`ORACLE_ROLE`; in
  `environments/demo.json` the oracle is the relayer address, a demo trust assumption, see DECISIONS/LIMITS).
- **Dropped:** appeals UI, evaluator, multiple humans, World ID staging/sandbox, and CC-12..CC-18 as planned.
  The contracts keep appeals/evaluator/forensics (tested), they are just not in the demo.
- `WORLD_ID_MODE=real|simulated` (server-only, default `real`). Simulated skips the World proof, enrolls at
  credential level 3 = SIMULATED (never Orb, capped like Selfie) and marks every API response `simulated: true`.
- **ENS is out of scope** (time + ENSv2 beta instability). Don't build ENS features unless the task is the
  BUILD_PLAN "Bonus" section, and only after Saturday 20:00 Madrid with everything else done.
- Stage 1 ("score published") = published **on-chain**: `PenaltyLedger` `Penalized` / `Forgiven` events and
  the on-chain `tokenURI` (current score + stage). Reads go to `PenaltyLedger.scoreOf` / `stageOf`.
- ENS publishing is future work: the `IScorePublisher` hook in `PenaltyLedger` exists and stays unset.
- `src/mirrors/ENSRoleMirror.sol` (ENSv1) stays out of audit scope and unused: don't deploy or wire it.

## Layout (target monorepo)
- `contracts/` Foundry: `HumanRegistry`, `PermissionRegistry`, `ValidationReceipts`, `PenaltyLedger`, `WorldIDVerifier`
  (deps in `contracts/lib` are git submodules: clone with `--recurse-submodules`)
- `legacy/` the original Zone 1 orchestrator + local demo (reads `contracts/out`)
- `app/` Next.js (App Router, TypeScript): UI, API routes, agent, attester, relayer
- `scripts/` deployment (ENS setup deferred)
- `config/<chainId>.json` addresses, written by `contracts/script/Deploy.s.sol` (never hard-code addresses in code)
- `environments/*.json` rule presets
- `docs/` DECISIONS, RULES, TRUST, DEBRIEF, LIMITS, BUILD_PLAN

## Commands
- `cd contracts && forge build && forge test` (must stay green; currently 92 tests)
- `cd app && npm run lint && npm run typecheck && npm test`
- Local chain demo (legacy orchestrator): `cd contracts && forge build && cd ../legacy && npm install && node demo.js`

## Invariants you must never break (from AUDIT.md)
- No token is minted at validation. Penalties are minted only by `ValidationReceipts` (MINTER_ROLE)
  after a forensics ruling on a real receipt, with evidence, inside the liability window, after due process.
- Anyone who rules (forensics, appeals, evaluator) must be an **enrolled human**; compare humans, never addresses.
  Only exception: the **oracle** (`ORACLE_ROLE`, AUDIT C-10), which still goes through the normal ruling path.
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
