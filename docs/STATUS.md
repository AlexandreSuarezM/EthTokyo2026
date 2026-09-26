# Status

_Last updated: Saturday 2026-09-26 (Madrid)._

## Scope (2026-09-26): single-user demo

One **validator** (the human pressing Approve / Reject) and one **oracle** (the server that generated the code
and knows if it was wrong). Dropped: appeals UI, evaluator, multiple humans, World ID staging/sandbox, and
CC-12 … CC-18 as planned. The demo runs `WORLD_ID_MODE=simulated` (our only real World ID has no 4.0 credential:
`credential_unavailable`). Details: `docs/DECISIONS.md`, `docs/LIMITS.md`.

## Deadline

**Sunday Sep 27, 09:00 JST = Sunday 02:00 Europe/Madrid.** No late submissions.
Our own cut-off: **submit before Saturday 24:00 (Sunday 00:00) Madrid**, leaving two hours of margin.

## Done

- **Contracts:** HumanRegistry, PermissionRegistry, ValidationReceipts, PenaltyLedger, WorldIDVerifier; `AUDIT.md`
  revision 3. **92 forge tests green**, including the oracle (`ORACLE_ROLE` + `oraclePenalize`) and the SIMULATED
  credential level. Deploy script grants the oracle from the preset; `environments/demo.json` added.
- **App backend:** CC-8 (env, RP signing, storage, attester, relayer), CC-9 (enrollment), CC-10 (proposals,
  deny = new round, accept = World ID session proof or simulated → attester + wallet signature → `validate()`),
  World ID 4.0-only parsing, `WORLD_ID_MODE=real|simulated`. **137 app tests green**, on-chain ones on anvil.
- **Real World ID smoke test (`/dev/enroll`):** runs against the real verify API; blocked by
  `credential_unavailable` (no World ID 4.0 credential on our only World ID). Logged in `docs/DEBRIEF.md`.

## Order for the rest of Saturday

1. Oracle service: the server compares its own knowledge with the validator's decision and calls
   `oraclePenalize` with evidence (reduced CC-11), plus standing reads (score, stage, penalties)
2. Demo UI: enroll (simulated) → prompt → proposal → Approve / Reject (reject = new round) → receipt →
   oracle verdict → score / stage
3. Fund the deployer and relayer wallets; deploy to Sepolia with `HITL_ENV=demo` (CC-19)
4. CC-20 docs + final security pass, finish `docs/DEBRIEF.md`
5. Record the demo
6. **Submit before 00:00 Madrid**
