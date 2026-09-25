# Rules

Decided 2026-09-26. The numbers below are the `environments/team-default.json` preset (the demo
environment). `solo-startup` and `regulated-fintech` use different numbers; each preset's JSON is the
source of truth for its own numbers. CC-3 reads this file: nothing here changes contract behavior.

## Scope

- **ENS is out of scope.** Stage 1 ("score published") means published on-chain: the `PenaltyLedger`
  `Penalized` / `Forgiven` events and the on-chain `tokenURI`. The `IScorePublisher` hook stays unset.
- Cross-org identity (one World ID app for all orgs, or one per org): **not decided**. The demo uses one app.

## Enrollment

- One human = one account (World ID Proof of Human, level ORB).
- Selfie Check is the fallback credential (level SELFIE).
- **Selfie cap = repo tier 1.** A Selfie-only human may hold and use `REPO_TIER` at most 1
  (`policy.maxTierForSelfie = 1`). Granting above the cap reverts (`AboveSelfieCap`).

## Validation

- Repos at tier >= 2 (`policy.liveProofTier`) need a live personhood proof at approval time.
- Self-approval is allowed (`policy.allowSelfApproval = true`).

## Forensics and due process

- Liability window: 30 days after the receipt. Appeal window: 3 days after a ruling.
- Whoever rules must be an enrolled human, never the validator. The appeal reviewer is a different human
  from both the judge and the validator.
- Flags: 1-day cooldown, 3 baseless flags within 90 days is the limit.

## Penalties and score

- Penalty weight = base × (2 if major) + 100% of the current score. Base = 100 points. Score cap = 1000.
- **Fade: as built, per mistake.** The score falls linearly at base / fade period = 100 points per 30 days.
  One minor penalty clears in exactly 30 days; a bigger score takes proportionally longer. Each account keeps
  the decay rate it had when its score last changed, so a config change is never retroactive.
- **Forgiveness: as built.** One evaluator (`EVALUATOR_ROLE`, an enrolled human) may reduce a score by any
  amount, down to 0, with a mandatory reason. Nobody may forgive themselves. No per-call cap, no second evaluator.

## Stages

| Stage | Score | Effect |
|---|---|---|
| 0 | 0 | clean |
| 1 | > 0 | score published on-chain |
| 2 | >= 200 | no AI access |
| 3 | >= 500 | banned: no validating, submitting or flagging |

## Environments

- Database: **SQLite** locally (`DATABASE_URL=file:./dev.db`), **Neon Postgres** for the deploy.
- Hosting: **Vercel**.
- Chain: Sepolia.
