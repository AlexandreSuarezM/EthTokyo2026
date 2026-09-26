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

## DEMO_PLAN progress (see docs/DEMO_PLAN.md)

- 13:35 Step 1 (contracts): count-based ladder + judge lift + `fadeSeconds`, demo preset; 100 forge + 137 app tests
  green. Keys rotated (old ones were exposed).
- 14:25 Step 1 (deploy): demo preset on Sepolia, `config/11155111.json`; roles verified on-chain (oracle + judge =
  relayer `0x99fa…8328`, minter = receipts, attester set, ladder 3/true, fade 300 s, appeal 0, liability 365 d).
- 14:45 Steps 2–5 (+6 by script): `/demo` page (sign in, AI answer, standing, receipts), fake AI from files, reject =
  new round, approve → receipt, judge reveal + fingerprint + mint, countdown, judge lift. Full ladder run on Sepolia
  through the API with a throwaway wallet: token 1 (297 s) → lift → 2× Good decision → token 2 (597 s) → lift →
  token 3 → banned; lift and ask refused when banned. 150 app tests green. Clips: user to record with MetaMask.
- 15:10 Scope add: reward points + prize (`ChallengeRewards`), deployed to Sepolia; judge awards +1 per correct
  approval (60 s cooldown), slashes on a wrong one; opt in at 5; equal split after 21:00. Verified on Sepolia
  (5 points → opt in → wrong approval → points 0, prize seat kept). 110 forge + 151 app tests.

## Order for the rest of Saturday (superseded by docs/DEMO_PLAN.md)

1. Oracle service: the server compares its own knowledge with the validator's decision and calls
   `oraclePenalize` with evidence (reduced CC-11), plus standing reads (score, stage, penalties)
2. Demo UI: enroll (simulated) → prompt → proposal → Approve / Reject (reject = new round) → receipt →
   oracle verdict → score / stage
3. Fund the deployer and relayer wallets; deploy to Sepolia with `HITL_ENV=demo` (CC-19)
4. CC-20 docs + final security pass, finish `docs/DEBRIEF.md`
5. Record the demo
6. **Submit before 00:00 Madrid**
