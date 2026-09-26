# DEMO_PLAN — single-user demo on Sepolia (scope change, Sat 26 Sep 12:45 Madrid)

This file supersedes `docs/BUILD_PLAN.md` for everything after CC-11. Hard deadline: submit on ETHGlobal
before **23:30 Madrid** (official close 02:00, no late submissions).

## 1. What changed and why

The full plan (several humans, appeals, evaluator, staging/sandbox World ID, real agent, GitHub merge) does not
fit the remaining time. We keep the core idea and cut everything else.

| Kept | Cut (documented in `docs/LIMITS.md`) |
|---|---|
| World ID enrollment (real; simulated fallback behind a flag) | Multiple humans, appeals UI, human evaluator |
| Approve / Reject by the human, receipt on-chain, no token at approval | Staging / Sandbox World ID, Developer Portal MCP |
| Penalty token: soulbound, escalating, capped, fading | Real LLM agent, World ID for Agents SDK flow |
| Stages: restricted → longer restriction → banned | GitHub PR / merge gate (CC-13, CC-17), E2E suite (CC-18), ENS |
| Contracts on Sepolia | Multi-wallet role holders |

**Naming** (code, UI and docs):
- **User / validator**: the human who presses Approve or Reject.
- **Judge**: a server oracle (address = the RELAYER address) that knows whether the AI answer was right, mints
  penalty tokens (`ValidationReceipts.ORACLE_ROLE`) and can lift restrictions (`PenaltyLedger.JUDGE_ROLE`).
  A demo trust assumption.
- **AI**: a fake generator that serves hello-world variants from files (no LLM).

## 2. The demo (acceptance checklist)

| # | What the viewer sees | Reuse |
|---|---|---|
| 1 | Connect wallet (MetaMask, Sepolia) | CC-9 |
| 2 | World ID check; if it fails, `WORLD_ID_MODE=simulated` with a yellow "World ID: simulated" badge | CC-9, /dev/enroll |
| 3 | "Ask the AI: write a hello world function" → code card, right or wrong 50/50 | new (small) |
| 4 | Green Approve / red Reject. Reject = new answer, round +1, nothing on-chain | CC-10 |
| 5 | Approve → World ID (real or simulated) + wallet signature + `validate()` → receipt on Sepolia, no token | CC-10 |
| 6 | Judge reveals the verdict + "fingerprint matches ✓" → right: "Good decision ✓" | new |
| 7 | Wrong: judge mints a soulbound penalty token to the user (Etherscan link) | PenaltyLedger + judge |
| 8 | Token 1 → restricted ~5 min (Ask/Approve disabled), live countdown, lifts by itself or the judge lifts it early (reason required; token stays) | fade + judgeLift |
| 9 | Token 2 → longer restriction (~10 min), judge can lift it | ladder |
| 10 | Token 3 → banned: "Repo access closed", Ask/Approve permanently disabled; the judge cannot lift a ban (say so on screen) → end | ladder ban |

**Rules of the demo**
- Only "approved wrong code" is punished. Reject never mints (rejecting correct code just asks again).
- The judge removes the restriction, never the token (the token is the permanent record).
- The verdict is committed before the user decides: `contextHash = hash(code, verdict, salt)`; the judge reveals
  verdict + salt later and the page shows the check. Never send verdict/salt to the client before the judge runs.

## 3. Rules for the session

- Run `date` before each step. Each step has a deadline; if it will be missed, stop at the last working state,
  commit, push, and report what was cut.
- Smallest working solution; reuse CC-8..CC-11, /dev/enroll, contracts, deploy script. No refactors, no new
  dependencies unless unavoidable.
- Automated tests on anvil; the page and the video run on Sepolia (`config/11155111.json`).
- Every step ends: tests green → merge to main (`--no-ff`) → push → report (max 10 lines) → click path.
- Never read or print `.env` values or private keys. Public addresses only.
- Update `docs/STATUS.md` (one line per step) and `docs/DEBRIEF.md` as we go.

## 4. Steps and deadlines (Madrid)

| Step | What | Deadline |
|---|---|---|
| 1 | Contracts (ladder, judge lift, fadeSeconds), new keys, Sepolia deploy | 13:45 |
| 2 | `/demo` page layout + wallet + World ID enroll (clip 01) | 14:30 |
| 3 | Fake AI (1 correct + 5 wrong hello-world variants) + Reject (clip 02) | 15:15 |
| 4 | Approve → receipt on Sepolia, `contextHash = hash(code, verdict, salt)` (clip 03) | 16:00 |
| 5 | Judge: reveal, mint, standing panel with countdown, lift (clip 04) | 17:00 |
| 6 | Full ladder in one sitting on Sepolia (clips 05–06) | 18:00 |
| — | Feature freeze (bug fixes only) | 19:00 |
| 7 | README, DEBRIEF, LIMITS, security pass, video script, repo public | 21:30 |
| — | Video 22:00–23:00, **submit 23:30** | |

## 5. Recording clips

Win + Alt + R starts/stops recording (Videos\Captures). Rename: `01-enroll.mp4`, `02-reject.mp4`, …; under 30 s
each; browser zoom 125 %. If a step's clip can't be recorded, the step isn't done.
