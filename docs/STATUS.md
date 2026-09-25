# Status

_Last updated: Friday 2026-09-25, evening (Madrid)._

## Deadline

**Sunday Sep 27, 09:00 JST = Sunday 02:00 Europe/Madrid.** No late submissions.
Our own cut-off: **submit before Saturday 24:00 (Sunday 00:00) Madrid**, leaving two hours of margin.

Target prizes: **World IDKit** and **World ID for Agents**. ENS is cut (see `docs/BUILD_PLAN.md`).

## Done

- **Contracts:** HumanRegistry, PermissionRegistry, ValidationReceipts, PenaltyLedger, WorldIDVerifier,
  with the security review in `AUDIT.md`. 75 tests green on `main` (55 original + 20 from CC-1);
  82 with the CC-2 deploy tests.
- **CC-0 monorepo:** merged (PR #1).
- **CC-1 attested enrollment + credential level:** merged (PR #2).
- **CC-2 Sepolia deploy script:** done on branch `cc-2-deploy-script`, dry-run on a Sepolia fork passes.
  **PR to open and merge.**
- **Accounts and secrets:** World app credentials, Sepolia RPC, and the deployer / relayer / attester keys are
  in `app/.env.local`. Never read, print or commit its values.
- **Rules:** decided. Still to write down in `docs/RULES.md` (it has only headings); CC-3 reads it from there.

## Paused

- Funding the deployer and relayer wallets with Sepolia ETH: needed only at deploy time
  (the deploy costs about 0.03 ETH).

## Order for Saturday

1. Merge CC-2 (`cc-2-deploy-script`)
2. CC-8 app backend base + RP signing
3. CC-9 enrollment flow
4. CC-10 approval verification + receipt
5. CC-12 agent with human approval
6. CC-14 enroll page
7. CC-15 session page
8. CC-16 forensics + directory pages (directory reads the contracts, not ENS)
9. Fund the deployer and relayer wallets
10. CC-19 deploy to Sepolia, using the CC-2 script
11. CC-20 docs + final security pass, and finish `docs/DEBRIEF.md`
12. Record the demo
13. **Submit before 00:00 Madrid**

Bonus ENS (BUILD_PLAN section 4) only if everything above is merged by **Saturday 20:00 Madrid**.

## Cut order if late

Drop in this order: **CC-17** merge gate → **CC-13** GitHub merge + receipt linkage → **CC-18** end-to-end tests.
