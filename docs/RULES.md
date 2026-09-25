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

## Identity

- Every World proof, at enrollment or at approval, must map to the **same stored `humanId`** created at
  enrollment, so a person's receipts, penalties and score all stack on one human.
- We use the proof type the docs support for that: enrollment creates a World ID session and stores its
  `session_id` against the `humanId`; every approval is a session proof (`proveSession`) whose verified
  `session_id` must equal the stored one (see `docs/DECISIONS.md` Q1). A per-action nullifier is used only
  for replay protection, never as an identity.
- A proof that doesn't map to an enrolled `humanId` is rejected.

## Validation

- **No presence (liveness) tier for now.** `policy.liveProofTier = 4` in every environment file, above every
  repo tier (0–3), so no repo requires a live proof. Presence (`require_user_presence`) is future work.
- Self-approval is allowed (`policy.allowSelfApproval = true`).
- **Fail closed.** If any expected field in a World verify response is missing or malformed (`success`,
  `session_id`, `environment`, nullifier, per-credential `results`, …), the server returns a typed error
  and performs no transaction, no receipt and no merge.
- **Single use.** Every World approval is consumed once (unique key in the database); a replay is rejected.
- One receipt per human per change, and one penalty per receipt (both already enforced on-chain:
  `validatedBy[commitHash][human]` and `penaltyOfReceipt`).

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
