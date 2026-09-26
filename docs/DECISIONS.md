# Decisions

Answers to the BUILD_PLAN H6 questions, checked against the official docs on 2026-09-26.
Where the docs don't answer, it says **not documented** and states what we assume.

## World ID (app, RP, actions, environment)

### Q1 — Can the HITL SDK use a session proof (`proveSession`), or must we use `useHumanApproval` + IDKit directly?

**Not documented.** What the docs do say:
- `requestHumanAuthorization(options)` takes only `action`, `signingKey` and `rpId`.
  `<HumanApproval>` takes a `preset` prop (default `orbLegacy()`) and `allowLegacyProofs` (default `false`).
  Session proofs are not mentioned anywhere in the SDK reference.
  ([HITL SDK reference](https://docs.world.org/agents/human-in-the-loop/sdk-reference.md),
  [HITL integrate](https://docs.world.org/agents/human-in-the-loop/integrate.md))
- Session requests are signed **without an action** ("session requests do not take an action or support
  legacy proofs"). The HITL flow is built on an action-bound request (default action = `toolCallId`).
  ([Session proofs](https://docs.world.org/world-id/idkit/session-proofs))

Why it matters: every approval must map to the `humanId` stored at enrollment (`docs/RULES.md`, Identity).
Only a session proof gives that link: `proveSession` returns the same `session_id` that enrollment stored, and
the backend "must associate [it] with the user account" and check it matches on every later proof
([Session proofs](https://docs.world.org/world-id/idkit/session-proofs)). A uniqueness proof's nullifier is
different for each action, so it can't link an approval to the enrolled human.

**Assumption:** the SDK's approval flow is action-bound and can't do `proveSession`. For CC-10 / CC-15 we
use IDKit directly (`proveSession` with the account's stored `session_id`), verified by our own backend. We
bind the commit through the validator's wallet signature over `HumanApproval` and a one-time server key
`merge:${repoId}:${commitHash}`. The agent still pauses through a Workflow webhook, like the SDK does.
To confirm with World at the event.

### Q2 — Can `require_user_presence` be combined with `proveSession`?

**Not documented.** What the docs do say:
- `require_user_presence` is "a request-level flag, not a credential". It works with every credential type
  and fails with `user_presence_failed` if the liveness check does not complete.
  ([Credentials](https://docs.world.org/world-id/idkit/credentials))
- The session proofs page does not mention it ([Session proofs](https://docs.world.org/world-id/idkit/session-proofs)).
  The verify request accepts an optional `user_presence_completed` field
  ([POST /v4/verify](https://docs.world.org/api-reference/developer-portal/verify)).

**Decision: not used for now.** No repo requires presence (`liveProofTier = 4` in every environment, see
`docs/RULES.md`), so we never set `require_user_presence`. Presence is future work. **Assumption for that
future work:** since it's a request-level flag, it can be set on `proveSession`, and the server would require
`user_presence_completed === true` in the verified payload.

### Q3 — Field names in the `/api/v4/verify` response

Documented ([POST /v4/verify](https://docs.world.org/api-reference/developer-portal/verify),
[IDKit integrate](https://docs.world.org/world-id/idkit/integrate)).

Request body (the IDKit result, forwarded as-is, plus `environment`):

| Proof | Key fields |
|---|---|
| Uniqueness (Proof of Human) | `protocol_version: "4.0"`, `nonce`, `action`, `responses[]` of `{ identifier, issuer_schema_id, nullifier, expires_at_min, proof }` |
| Selfie Check | same as uniqueness with `issuer_schema_id: 11`, plus `sybil_score` and `integrity_bundle` (version 2) |
| Session | `protocol_version: "4.0"`, `nonce`, `session_id`, `responses[]` with `session_nullifier` (a pair `[nullifier, action]`) instead of `nullifier` |
| Optional | `action_description`, `environment` (`production` \| `staging` \| `sandbox`), `integrity_bundle`, `user_presence_completed` |

Success response (200):

| Field | Notes |
|---|---|
| `success` | `true` |
| `action` | the bound action |
| `nullifier` | 256-bit value; convert hex to decimal before storing |
| `created_at` | date-time |
| `environment` | `production` \| `staging` \| `sandbox`; must equal what we expect |
| `session_id` | format `session_<128 hex>` |
| `results[]` | `{ identifier, success, nullifier, code, detail }` per credential |
| `message` | |

Errors: 400 `app_not_migrated`, 400 `all_verifications_failed` (with per-credential `results`), 404 app not found or inactive.

**Selfie Check `sybil_score`:** it is in the IDKit result we forward, **not** in the success response.
We read it from the forwarded payload only after verification succeeds, as the credentials page says.
**Replay:** for session proofs, reject any reused `session_nullifier`, and never use it as an account id.
**Fail closed:** if any field we rely on (`success`, `environment`, `session_id`, the nullifier, `results[]`)
is missing or malformed, the server returns a typed error and sends no transaction (`docs/RULES.md`).

### Q4 — What storage does `consumeApproval` need, and does the Workflow runtime need a specific host?

- **Storage (documented):** `consumeApproval(key: string): Promise<boolean>` "atomically records an approval
  key; returns false if it was already used. Back it with durable storage (e.g. a unique database key), not
  memory." The SDK doesn't ship an implementation; we write it.
  ([HITL integrate](https://docs.world.org/agents/human-in-the-loop/integrate.md))
  → a table with a unique key: SQLite locally, Neon Postgres when deployed (see `docs/RULES.md`).
- **Host: not documented.** Packages: `@worldcoin/human-in-the-loop ai@^6 workflow @workflow/ai zod` on the
  server, `@worldcoin/human-in-the-loop-react @worldcoin/idkit ai@^6 react` on the client. The README asks for a
  "Node-compatible runtime"; the example uses Next.js 16. ([README](https://github.com/worldcoin/human-in-the-loop))
  **Assumption:** Vercel with the Node runtime (our app is on Next.js 16.3). Workflow routes never run on the Edge runtime.

### Q8 — The event's "World ID for Agents" dev environment

**Pending organizers; assume the SDK default with mocked proofs.**

## ENSv2 (names, resolver, registry addresses)

Out of scope (ENS cut, see `docs/RULES.md`). Q5–Q7 are not answered.

## Networks and addresses

Sepolia. Addresses come from `config/<chainId>.json`, written by `contracts/script/Deploy.s.sol`.

**Who sends which transaction (found in CC-8):** `HumanRegistry.enrollAttested` and `rotateKeyAttested`
enroll `msg.sender`, so the **human's own wallet** sends them, with the attester's signature from the backend.
The relayer can't (it would enroll itself). The relayer only submits `ValidationReceipts.validate`, where the
validator is identified by their EIP-712 signature. This replaces "relayer submits" in BUILD_PLAN CC-9.

## Enrollment (CC-9)

- **Two proofs, both verified on the server** (sessions are not uniqueness proofs,
  [Session proofs](https://docs.world.org/world-id/idkit/session-proofs)):
  1. `POST /api/enroll/start`: uniqueness proof, action `hitl-enroll`, signal `hitl-enroll:<wallet>`.
     Its nullifier gives `humanId = keccak256(abi.encode("hitl.human.v1", nullifier))`: one per person.
  2. `POST /api/enroll/complete`: `createSession` proof, signal `hitl-session:<enrollmentId>`, same credential.
     Its `session_id` is **the account id** (never the `session_nullifier`, which is only replay protection).
     Stored once per human, per `session_id` and per enrollment nullifier; then the attester signs
     `enrollAttested` and the human's wallet sends it.
- **HumanRegistry check:** the attester's signature binds `msg.sender` (in the signed struct), the chain and the
  contract (EIP-712 domain) and a deadline; used digests are recorded. Tests:
  `test_AttestedEnrollIsBoundToSender`, `test_AttestedEnrollIsBoundToChain`, `test_AttestedEnrollExpiredReverts`,
  `test_AttestedEnrollReplayReverts`, plus an app test where another wallet's copy of the attestation reverts.
- **Resume:** if the wallet never sent the transaction, a new uniqueness proof from the same wallet re-issues the
  attestation for the stored session. Another wallet is refused (`already_enrolled`).
- **Known limit:** the two proofs can't be linked cryptographically. Two people colluding (one does the uniqueness
  proof, the other the session) could split identity and approvals. The session is bound to the pending enrollment
  by its signal and must use the same credential, so this needs both people to cooperate on purpose.
- `WORLD_ENVIRONMENT` (default `production`) is the only environment the server accepts; `staging` is for the
  simulator only.

## Reward points and prize pool (2026-09-26 15:00)

Two tokens: the **accountability token** (PenaltyLedger: minted for approving wrong code, permanent, 3 = banned) and
**reward points** (new `contracts/src/ChallengeRewards.sol`, separate so the audited contracts are untouched).
- **Earn:** the judge awards **1 point** for a real receipt it ruled correct: once per receipt, only to that receipt's
  validator (status Valid/Cleared), and **at most one point per `cooldown`** (the challenge difficulty in hours; 60 s
  in the demo so it can be recorded). Points are soulbound: the contract has no transfer function at all.
- **Slash:** the judge (automatically, when it mints an accountability token) or the owner sets a human's points to 0.
- **Prize:** ETH funded by the owner. A human with **>= 5 points** opts in before the deadline; that is final (a later
  slash takes the points, never the share). After the deadline each opted-in human claims an **equal share**. If
  nobody opted in, the owner withdraws the pool.
- **Sepolia:** `config/11155111.rewards.json` (`0x9d918d9f1Aa9Ae0a88679858718D0191973EC270`), pool 0.02 ETH, deadline
  21:00 Madrid 26 Sep, cooldown 60 s, threshold 5, judge = relayer. A first deployment
  (`0xAb95C5258d8633b9434f5e6E4D341E2167733753`) was used by the Sepolia smoke test; its throwaway wallet opted in and
  its key is gone, so that pool (0.02 test ETH) is stuck: not used by the demo.

## Demo ladder and judge (DEMO_PLAN step 1, 2026-09-26 13:30)

- **Judge** = a server oracle at the RELAYER address, holding both `ValidationReceipts.ORACLE_ROLE` (mints penalty
  tokens via `oraclePenalize`) and `PenaltyLedger.JUDGE_ROLE` (lifts restrictions via `judgeLift`). Neither requires
  enrollment: a demo trust assumption (AUDIT C-10, C-12; `docs/LIMITS.md`). The preset says `"oracle": "operator"`
  and `"judge": "operator"`; the deploy script grants both to the operator (relayer) address.
- **Count-based ladder** (`PenaltyLedger.setLadder`, off by default so other presets keep today's behaviour):
  `weightByCount` = token n weighs `base x n`; `banAtCount` = holding that many tokens is a permanent stage 3 that
  no fade, forgive or lift undoes. Why: with score-based escalation a judge lift resets the score to 0, so token 2
  would be no longer than token 1, and token 3 would not ban.
- **`demo.json`**: base 100, `fadeSeconds` 300, `stage2At` 1 (any score of 1 point or more = "restricted", no AI),
  `banAtCount` 3, `weightByCount` true. Token 1 = restricted ~5 min (until the score drops under 1 point, ~297 s),
  token 2 = ~10 min, token 3 = banned forever. `judgeLift` sets the score to 0 (reason required, the token stays)
  and reverts `BannedForever` on a ban. The deploy script now accepts `fadeSeconds` as well as `fadeDays`.
- On-chain, "restricted" (stage 2) turns off `AI_SUBMIT` only; the demo UI also disables Approve while restricted.

## Single-user demo: validator, oracle, simulated mode (2026-09-26)

- **Naming.** *Validator* = the human pressing Approve / Reject. *Oracle* = the server that generated the code
  and knows whether it was wrong.
- **Oracle on-chain.** A role grant was not enough: `audit` requires the caller to be an enrolled human
  (`NotEnrolled`), and the server is not one. Smallest change: `ValidationReceipts.ORACLE_ROLE` +
  `oraclePenalize(id, evidenceHash, major)`. It reuses `_openCase` (real receipt in standing, evidence, liability
  window) and the same ruling path as `audit` (appeal window, one penalty per receipt in the ledger, soulbound,
  cap, fade unchanged). The oracle can't rule on a receipt of its own human. Tests: `contracts/test/Oracle.t.sol`.
- **Demo trust assumption: oracle = relayer.** `environments/demo.json` has `"receipts": {"oracle": "operator"}`;
  the deploy script grants `ORACLE_ROLE` to the operator (the relayer, from the `OPERATOR` env var). No address
  is written in the preset. Other presets grant no oracle. See `docs/LIMITS.md` and AUDIT C-10.
- **`demo.json` numbers.** Base 100, escalation 100%: mistake 1 = 100 (stage 1), mistake 2 = 100 + 100 = 300
  (stage 2 at 200: no AI), mistake 3 bans (stage 3 at 500). Fade 100 points per day (fadeDays 1, the minimum the
  deploy script takes). Liability window 365 days. Appeal window 0 (no appeals UI): the penalty is minted at once.
  One repo, `demo/app`, tier 1 (a simulated human is capped at `maxTierForSelfie = 1`).
- **`WORLD_ID_MODE=real|simulated`** (server-only, default `real`). Our only real World ID has no 4.0 credential
  (`credential_unavailable`), so the demo needs a mode without World proofs:
  - enrollment: `POST /api/enroll/simulated {account}` (404 unless simulated) returns an attestation at credential
    level **3 = SIMULATED** (never Orb; `HumanRegistry.LEVEL_SIMULATED`, capped like Selfie). The wallet still sends
    `enrollAttested` itself. `humanId = keccak256(abi.encode("hitl.human.simulated.v1", account))`: a separate
    namespace, so it can never collide with a real human's id;
  - approval: `complete` takes no World result; the wallet signature must come from an enrolled **simulated**
    human (a real Orb/Selfie human can never be approved for without a proof). Single use is unchanged;
  - every API response carries `simulated: true`, and the server logs a warning at startup.

## One protocol version per action: World ID 4.0 only (smoke test, 2026-09-26)

- **Found:** in the first real test, World App answered our `proofOfHuman()` request with a **legacy 3.0** proof
  (`protocol_version: "3.0"`, `identifier: "orb"`, `merkle_root`), although we set `allow_legacy_proofs: false`.
  The SDK documents that preset as "a World ID 4.0 proof-of-human credential with legacy Orb fallback".
- **Why one version:** a 3.0 and a 4.0 proof from the same person give **different nullifiers** for the same
  action. The IDKit SDK says about `allow_legacy_proofs: true`: "You must track both v3 and v4 nullifiers to
  prevent double-claims." Accepting both would let one person enroll twice (two `humanId`s).
- **Why 4.0:** sessions exist only in 4.0 ("Sessions are always World ID v4 - there is no legacy (v3) session
  support", IDKit SDK), and enrollment and every approval use sessions. A 3.0-only user could never finish
  enrollment anyway, and picking 3.0 now would force everyone to re-enroll with a new `humanId` when 3.0 is retired.
- **Enforced:** the client requests 4.0 only (`constraints: CredentialRequest("proof_of_human")`, no legacy
  fallback); the server refuses any other `protocol_version` with `unavailable_credential` ("World App sent a
  legacy World ID 3.0 proof ... update World App").
- **Parsing:** the server requires only the fields it depends on (protocol version, action, environment,
  signal, nullifier / session_id, credential) and fails closed if they're missing. Every other field World
  App adds is kept and the result is forwarded to World's verify API **unchanged**; World judges the proof.
  A result from another environment is refused, not rewritten.

## Approval and receipt (CC-10)

- **Deny with new input** closes the proposal (`POST /api/proposals/deny`). No receipt, nothing on-chain. The next
  round is a new proposal (`reviseProposal`) whose context is rebuilt from the base task plus every deny input so
  far. One revision per denied proposal (unique `parent_id`).
- **Commit hash from the repository, never from the client or the LLM.** The server reads base..head from a local
  checkout (`REPOS_ROOT/<owner>/<name>`, `git rev-parse` / `git diff`): commit sha, diff, line count. On-chain
  `commitHash` = the git sha left-padded to 32 bytes (SHA-256 repos: the sha itself); `repoId` =
  `keccak256(bytes(name))` like `Deploy.s.sol`. `contextHash` = keccak256 of what the validator was shown (task,
  deny inputs, round, shas, diff). The change is re-read at accept; if the branch moved, it's `stale`.
- **Accept = two calls.** `POST /api/approve/prepare` builds the `HumanApproval` on the server and returns it for
  the validator's wallet to sign, plus the World ID signal `hitl-approve:<approvalDigest>`.
  `POST /api/approve/complete` takes the wallet signature and a `proveSession` result made at that moment: the
  proof's signal must match the approval, the verified `session_id` must map to an enrolled `humanId`, the wallet
  that signed must be that human's account on-chain, and the credential must match the enrollment.
  Session requests have no action (see Q1), so the World proof is bound to the approval by its **signal**, not by
  the action string `merge:${repoId}:${commitHash}` from BUILD_PLAN.
- **Single use, in the database:** the pending approval (taken once), the proof's session nullifier (action
  `hitl-approve`), and one approval key per `(repoId, commitHash, humanId)`. A second validator can approve the
  same commit (tier-2 repos need two). The key is released only when the relayer's simulation refused the call
  (no transaction was sent); if a transaction may have been sent, it stays consumed.
- The attester signs `HumanAttestation(approvalDigest, proofRef, presence = false)`; `proofRef` = keccak256 of the
  verified World ID result, which is kept in the `receipts` table for audit. The relayer simulates `validate()`
  first, so banned / no permission / Selfie above its cap / not enrolled is a typed error and no transaction.
- **World environment:** one config value, `WORLD_ENVIRONMENT` (default `production`), used by enrollment and
  approval alike. Staging is currently refused by World for our app (see `docs/DEBRIEF.md`).

## Agent and model

See Q1, Q4 and Q8.

## Storage (DATABASE_URL)

`DATABASE_URL=file:./dev.db` (SQLite) locally, Neon Postgres when deployed. Tables: nullifiers (unique on
action + nullifier, stored as decimal strings), sessions, consumed approvals (unique key).

## Open questions

- Q1: does the HITL SDK (or IDKit through it) support `proveSession`? Ask World at the event.
- Q8: pending organizers (dev environment URL, app id, which proofs are mocked).
- Cross-org identity (one World ID app for all orgs or one per org): not decided.
