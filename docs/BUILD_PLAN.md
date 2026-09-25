# Build plan — granular, parallel

**Legend**
- 🟢 **YOU (docs only):** you can do it yourself by following the official docs or dashboards; no code from this repo is needed. Start these right away.
- 🟡 **YOU + DOCS, verify:** read the docs and write the answer into `docs/DECISIONS.md`. These unblock specific Claude Code tasks.
- 🔵 **CLAUDE CODE:** paste the prompt into a Claude Code session. Each prompt stands on its own.
- ⛔ **DECIDE:** a choice only you can make.

## 0. Parallel lanes

Run each lane in its own git worktree and Claude Code session (`git worktree add ../hitl-<lane> -b lane/<lane>`).
Lanes own different directories, so they don't conflict. Merge in the order at the bottom.

| Lane | Owns | Tasks | Can start when |
|---|---|---|---|
| **H** you | dashboards, accounts, `docs/DECISIONS.md` | H1–H9 | now |
| **0** bootstrap | repo layout, CI | CC-0 | now (first; everything else branches from it) |
| **1** contracts | `contracts/` | CC-1, CC-2, CC-3 | after CC-0 |
| **2** ENSv2 | `contracts/src/ens/`, `scripts/ens/`, `app/lib/ens/` | CC-4 … CC-7 | after CC-0; the live parts need H2 + H3 |
| **3** World backend | `app/app/api/`, `app/lib/world/`, `app/lib/chain/` | CC-8 … CC-11 | after CC-0; works with mocks until H1 |
| **4** agent | `app/lib/agent/`, `app/lib/github/` | CC-12, CC-13 | after CC-8 |
| **5** frontend | `app/app/(pages)/`, `app/components/` | CC-14 … CC-16 | after CC-0 (mock the API first) |
| **6** merge gate | `.github/`, `gate/` | CC-17 | after CC-2 + CC-7 |
| **7** ship | tests, deploy, docs | CC-18 … CC-20 | last |

```
CC-0 ──┬─ Lane 1: CC-1 → CC-2 → (CC-3) ─────────────┐
       ├─ Lane 2: CC-4 → CC-5 → CC-6 → CC-7 ────────┤
       ├─ Lane 3: CC-8 → CC-9 → CC-10 → CC-11 ──┐   ├─► CC-17 → CC-18 → CC-19 → CC-20
       │                                        └─► Lane 4: CC-12 → CC-13
       └─ Lane 5: CC-14 → CC-15 → CC-16 (mock API, then wire) ┘
Merge order: CC-0, Lane 1, Lane 2, Lane 3, Lane 4, Lane 5, Lane 6, Lane 7
```

---

## 1. Your tasks (do these in parallel with Claude Code)

### 🟢 H1 World Developer Portal *(unblocks lanes 3 and 4)*
- [ ] Create an app at <https://developer.world.org>. Note the `app_id`, `rp_id` and the RP signing key.
- [ ] Create the actions `hitl-enroll` and `merge` (or whatever names the docs require for your flow).
- [ ] Enable the credentials: **Proof of Human**, and **Selfie Check** for the fallback path.
- [ ] Put the values in `app/.env.local` (never commit them): `NEXT_PUBLIC_WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNING_KEY`.
- [ ] Set up the test device or simulator the docs recommend, and the **event dev environment for World ID for Agents** (the organizers say proofs are mocked there).
- Docs:
  - <https://docs.world.org/world-id/idkit/integrate>
  - <https://docs.world.org/world-id/idkit/credentials>
  - <https://docs.world.org/agents/human-in-the-loop/integrate.md>

### 🟢 H2 ENS name on Sepolia *(unblocks lane 2, live part)*
- [ ] Get Sepolia ETH from a faucet.
- [ ] Register `<org>.eth` on the **ENSv2 beta** (ENS app / explorer beta, Sepolia). Note the name and the owner wallet.
- Docs:
  - <https://ens.domains/blog/post/ensv2-beta-public-testing>
  - <https://docs.ens.domains/ensv2/overview/>

### 🟢 H3 RPC and keys
- [ ] Get a Sepolia RPC URL (any provider) → `SEPOLIA_RPC_URL`.
- [ ] Create three fresh wallets, funded on Sepolia: `DEPLOYER`, `RELAYER`, `ATTESTER`. Use them for this project only.
- [ ] Create four more enrolled-human test identities for the roles: forensics, appeals, evaluator, and two users.

### 🟢 H4 GitHub
- [ ] Create a **public** repo with an MIT license, and push this scaffold.
- [ ] Create a second **demo target repo** where the agent will merge.
- [ ] On the demo repo's `main`: branch protection, a required status check named `hitl-gate`, and **admin bypass off**.
- [ ] Create a fine-grained token (or GitHub App) limited to the demo repo: contents read/write, pull requests, statuses → `GITHUB_TOKEN`.
- Docs: GitHub docs on branch protection rules and required status checks.

### 🟢 H5 Hosting
- [ ] Create the hosting project (e.g. Vercel) linked to `app/`.
- [ ] Add every server secret as a project environment variable.
- [ ] Provision a small database or KV store, used for nullifiers, sessions and consumed approvals.

### 🟡 H6 Verify these in the docs *(write the answers in `docs/DECISIONS.md`)*
| # | Question | Blocks | Where to look |
|---|---|---|---|
| Q1 | Does `@worldcoin/human-in-the-loop` accept a **session proof** (`proveSession`) as its preset, or must we use `useHumanApproval` + IDKit directly? | CC-10, CC-15 | HITL SDK reference; IDKit session proofs |
| Q2 | Can `require_user_presence` be combined with `proveSession`? | CC-10 | IDKit credentials; session proofs |
| Q3 | Exact field names in the `/api/v4/verify` response (`nullifier`, `session_id`, `environment`, …) for Proof of Human and for Selfie Check (`sybil_score`) | CC-9, CC-10 | IDKit integrate; API reference |
| Q4 | What does `consumeApproval` need for storage (KV? DB?), and does the `workflow` / `@workflow/ai` runtime need a specific host? | CC-12, H5 | HITL integrate page |
| Q5 | ENSv2: can `renew` **shorten** an expiry? If not, suspension = text record or `unregister` | CC-6 | `ensdomains/contracts-v2` `PermissionedRegistry.renew` |
| Q6 | ENSv2: exact signature of `authorizeTextRoles`, and how resources are encoded for per-key text permissions | CC-5 | `contracts-v2` `PermissionedResolver.sol`, `PermissionedResolverLib.sol` |
| Q7 | The ENSv2 Sepolia addresses currently in use (they are marked not final) | CC-4 | `contracts-v2/contracts/docs/addresses/sepolia.md` |
| Q8 | The event's "World ID for Agents dev environment": URL, whether an app id is required, and which proofs are mocked | CC-12 | event page / organizers |

### ⛔ H7 Decide *(write the answers in `docs/RULES.md`)*
- [ ] Fade semantics: **per mistake** (as built: 100 points per 30 days), or **the whole score clears within 30 days**?
- [ ] Forgiveness cap: unlimited (as built), a per-call cap, or two evaluators?
- [ ] Rulebook numbers: base, escalation %, cap, stage 2 and stage 3 thresholds, liability and appeal windows.
- [ ] Selfie Check cap: which maximum repo tier may a Selfie-only human validate?
- [ ] Cross-org identity: one World ID app for all orgs (sanctions follow the person) or one per org?

### 🟢 H8 Debrief log (both World prizes require it)
- [ ] Create `docs/DEBRIEF.md` now with these sections: time to first success · friction · missing capability/docs · the one improvement.
- [ ] Record timestamps as you go.
- [ ] Already known entries: the HITL SDK documents no error codes or staging option; World ID 4.0 on-chain verification is not available on Sepolia.

### 🟢 H9 Test the demo flow by hand
- [ ] Once lanes 3 and 5 are merged, run the flow yourself on staging with a real World App: enroll, approve, cancel, expire. Write down anything confusing in the debrief.

---

## 2. Claude Code prompts

Every prompt assumes Claude Code has read `CLAUDE.md`. Copy each block as-is.

### 🔵 CC-0 Bootstrap the monorepo *(Lane 0)*
```
Read CLAUDE.md, DESIGN.md and AUDIT.md.
Restructure the repo into a monorepo without changing contract behavior:
1. Move the Foundry project (src/, test/, script/, foundry.toml, lib deps) into contracts/.
   Keep `forge test` green (55 tests). Pin solc_version 0.8.28, via_ir, optimizer 200.
2. Keep orchestrator/ as legacy/ (a working local demo); update its artifact path to contracts/out.
3. Create app/ with Next.js App Router + TypeScript + ESLint + Vitest, and scripts/, config/, docs/.
4. Add .env.example (names only): NEXT_PUBLIC_WORLD_APP_ID, WORLD_RP_ID, WORLD_SIGNING_KEY,
   ATTESTER_PRIVATE_KEY, RELAYER_PRIVATE_KEY, SEPOLIA_RPC_URL, GITHUB_TOKEN, DATABASE_URL.
5. .gitignore: .env*, !.env.example, out/, cache/, node_modules/, .next/.
6. Add a gitleaks pre-commit hook and .github/workflows/ci.yml running: forge test (contracts),
   npm ci + lint + typecheck + test (app).
7. Create empty docs/DECISIONS.md, docs/RULES.md, docs/DEBRIEF.md, docs/LIMITS.md with section headers.
Done when: CI config is valid, `forge test` passes from contracts/, `npm run build` passes in app/.
```

### 🔵 CC-1 Attested enrollment + credential level *(Lane 1)*
```
Context: World ID 4.0 proofs can't be verified on-chain on Sepolia, so the backend verifies them
and co-signs (attester mode already exists in ValidationReceipts). Enrollment must work the same way.
In contracts/:
1. HumanRegistry: add enrollAttested(bytes32 humanId, bytes32 sessionRef, uint8 credentialLevel,
   uint256 deadline, bytes attesterSig) using EIP-712 (domain "HITLHumanRegistry","1"), bound to
   msg.sender, one human -> one account, replay-safe (deadline + used-digest set). credentialLevel:
   1 = ORB (Proof of Human), 2 = SELFIE. Keep the existing on-chain enroll path working.
   Store levelOf[humanId] and sessionRefOf[humanId]. Admin sets the attester address.
   Apply the same attester pattern to rotateKey (rotateKeyAttested).
2. PermissionRegistry: add policy field maxTierForSelfie; activeValue(REPO_TIER) for a SELFIE human
   returns min(value, maxTierForSelfie). Also make granting above the cap revert.
3. Tests: attested enroll happy path, wrong attester, replay, expired, second account for the same
   human, Selfie cap enforced in validate(), rotation keeps level/score. Follow AUDIT.md invariants.
4. Run slither (filter lib/test/mocks by absolute path) and add any new finding to AUDIT.md with a
   regression test.
Done when: forge test green, AUDIT.md updated, no new medium/high Slither findings.
```

### 🔵 CC-2 Sepolia deploy script *(Lane 1)*
```
Write contracts/script/Deploy.s.sol (Foundry script) that deploys HumanRegistry, PermissionRegistry,
ValidationReceipts, PenaltyLedger (WorldIDVerifier optional, behind a flag), wires every role
exactly like orchestrator/src/contracts.js::deployAll, sets attester mode (ATTESTER address from env),
and loads an environment JSON (environments/team-default.json) for policy/receipts/penalties/repos/presets.
Write deployed addresses to config/<chainId>.json. No hard-coded addresses. Add a README section
"Deploy to Sepolia" with the exact command. Test the script against a local anvil fork.
Done when: `forge script ... --fork-url $SEPOLIA_RPC_URL` dry-run succeeds and config JSON is written.
```

### 🔵 CC-3 Rule decisions *(Lane 1, after H7)*
```
Read docs/RULES.md (my decisions). Implement only what changed relative to the current contracts
(e.g. forgiveness cap per call or two-evaluator approval; whole-score fade instead of per-base fade).
Keep AUDIT.md invariants; add tests and update AUDIT.md sections 5 and 8 (numbers table).
```

### 🔵 CC-4 ENSv2 recon + addresses *(Lane 2)*
```
Clone https://github.com/ensdomains/contracts-v2 into a temp dir (do not vendor the whole repo).
Read: contracts/src/registry/PermissionedRegistry.sol, UserRegistry.sol, libraries/RegistryRolesLib.sol,
contracts/src/resolver/PermissionedResolver.sol, libraries/PermissionedResolverLib.sol,
contracts/src/access-control/EnhancedAccessControl.sol, the VerifiableFactory, UniversalResolverV2,
and contracts/docs/addresses/sepolia.md. Also https://docs.ens.domains/ensv2/overview/.
Produce docs/ENSV2_NOTES.md: exact function signatures we need (register, setSubregistry,
setResolver, renew, unregister, grantRoles, authorizeTextRoles, setText, factory deploy for
UserRegistry + PermissionedResolver proxies), role bit constants, how to encode EAC resources,
and whether renew can shorten expiry. Write config/sepolia.ens.json with the addresses.
Add minimal Solidity interfaces in contracts/src/ens/interfaces/ (only what we call).
Answer questions Q5–Q7 of BUILD_PLAN in docs/DECISIONS.md with file/line references.
```

### 🔵 CC-5 ENS publisher contract *(Lane 2)*
```
Using docs/ENSV2_NOTES.md, write contracts/src/ens/HitlEnsPublisher.sol implementing
IScorePublisher (PenaltyLedger) and IRoleMirror (PermissionRegistry). For each human's subname
<label>.<org>.eth it writes text records on that name's PermissionedResolver:
hitl.score, hitl.scoreUpdatedAt, hitl.decayPerSec, hitl.stage, and hitl.<PERMISSION> ("value;until=ts").
Only this contract may write hitl.* keys (authorizeTextRoles); the human keeps all other records.
Only PenaltyLedger / PermissionRegistry may call it. It must never revert into the caller (they call
it in try/catch with a gas cap), so keep each call well under 300k gas and test that.
Fork tests against Sepolia (forge test --fork-url $SEPOLIA_RPC_URL) using config/sepolia.ens.json.
Delete src/mirrors/ENSRoleMirror.sol (ENSv1). Update AUDIT.md scope and add findings if any.
```

### 🔵 CC-6 Subnames for humans and agents *(Lane 2)*
```
Write scripts/ens/setup-org.ts (viem): given the org name owner (from env), deploy a UserRegistry
proxy via VerifiableFactory as the org's subregistry (setSubregistry), grant HitlEnsPublisher /
the enrollment service the roles it needs (ROLE_REGISTRAR, ROLE_RENEW, ROLE_UNREGISTER,
ROLE_SET_RESOLVER), and record addresses in config/sepolia.ens.json.
Write app/lib/ens/registerHuman.ts: on enrollment, register <label>.<org>.eth owned by the human's
wallet, WITHOUT ROLE_CAN_TRANSFER_ADMIN (non-transferable), expiry = permission expiry, with its own
PermissionedResolver proxy. Then give that human's subname its own UserRegistry so agents register as
agent-<n>.<label>.<org>.eth with their own resolver; a human's hitl.stage is mirrored to their agents.
Implement suspension per the answer to Q5 in docs/DECISIONS.md.
Fork/integration tests. No hard-coded addresses.
```

### 🔵 CC-7 ENS reader *(Lane 2)*
```
Write app/lib/ens/read.ts using UniversalResolverV2 (viem) to resolve a human or agent name and
return { address, stage, score (decayed client-side from hitl.score/updatedAt/decayPerSec),
permissions }. Also listOrgMembers() for the directory page (use events or the registry as the docs
allow). Unit tests with recorded fixtures + one live Sepolia test behind an env flag.
This reader is what the merge gate and UI use, so ENS is the permission lookup, not decoration.
```

### 🔵 CC-8 App backend base + RP signing *(Lane 3)*
```
Read https://docs.world.org/world-id/idkit/integrate before coding.
In app/: env validation (zod) that fails fast and refuses to expose server secrets to the client;
app/lib/world/rp.ts using @worldcoin/idkit-core/signing (signRequest) with a fresh nonce per request;
route POST /api/world/rp-context. Storage adapter (DATABASE_URL) for nullifiers, sessions, consumed
approvals, with a uniqueness constraint (action, nullifier) stored as NUMERIC(78,0) or string.
app/lib/chain/relayer.ts and attester.ts (EIP-712 signing matching ValidationReceipts.ATTESTATION_TYPEHASH
and HumanRegistry's enrollAttested), reading addresses from config/<chainId>.json.
Unit tests for signing and for attester digests equal to the on-chain digest (use anvil + contracts/out).
Log friction to docs/DEBRIEF.md.
```

### 🔵 CC-9 Enrollment flow *(Lane 3)*
```
Read IDKit integrate, credentials and session-proofs docs (links in docs/BUILD_PLAN.md H1/H6).
Implement POST /api/enroll/start and /api/enroll/complete:
proofOfHuman request -> verify via POST https://developer.world.org/api/v4/verify/{rp_id} ->
check environment -> store nullifier (unique) -> createSession -> verify -> store session_id against
the account -> attester signs enrollAttested(humanId, keccak(session_id), ORB) -> relayer submits ->
register the ENS subname (app/lib/ens/registerHuman.ts if merged; otherwise leave a TODO behind a flag).
Selfie Check fallback: same flow with selfieCheck(), level SELFIE, store sybil_score.
Typed errors: cancelled, expired, rejected, already_enrolled, unavailable_credential. No tx on error.
Tests with mocked Developer Portal responses for every branch. Use field names from docs/DECISIONS.md Q3.
```

### 🔵 CC-10 Approval verification + receipt *(Lane 3)*
```
Implement app/lib/world/approve.ts used by the agent's merge tool and by the UI:
1. action string = `merge:${repoId}:${commitHash}` where commitHash is RECOMPUTED server-side from
   the repo (never from LLM input).
2. Verify the World ID result server-side, check the bound action, consume it once
   (consumeApproval or our storage), require session_id == the account's stored session,
   require presence for repos with tier >= policy.liveProofTier (per docs/DECISIONS.md Q1/Q2).
3. Build the HumanApproval struct, have the validator sign it (client-side wallet signature via the UI),
   attester signs HumanAttestation(approvalDigest, proofRef=keccak(verify response id), presence),
   relayer calls ValidationReceipts.validate. Return the receipt id.
Every failure path (cancelled, expired, rejected, replayed, ineligible: banned / Selfie on high tier /
not enrolled / no permission) returns a typed error and performs NO transaction and NO merge.
Tests for each path.
```

### 🔵 CC-11 Forensics, appeals, forgiveness API *(Lane 3)*
```
Routes (server-side role keys, each held by an enrolled human per AUDIT.md):
POST /api/forensics/audit {receiptId, correct, evidence, major}  -> ValidationReceipts.audit
POST /api/forensics/flag, /api/appeals/resolve, /api/receipts/finalize, /api/evaluator/forgive
GET  /api/standing/:human -> score, stage, penalties (read PenaltyLedger; cross-check ENS via app/lib/ens/read.ts)
Label /api/forensics/audit as the demo "was the validation right?" function in the UI.
Decode custom errors into readable messages (NotEnrolled, OwnReceipt, SameReviewerAsJudge,
AppealWindowOpen, LiabilityWindowClosed, Banned, ...). Tests on anvil.
```

### 🔵 CC-12 Agent with human approval *(Lane 4)*
```
Read https://docs.world.org/agents/human-in-the-loop/integrate.md and the SDK reference.
Build app/lib/agent/: a DurableAgent (per the docs' packages) with tools:
proposeChange (LLM produces a diff for a task), awaitReview (validator accepts, or denies with new input
-> context rebuilt from base task + feedback, not an ever-growing transcript), approveAction
(requestHumanAuthorization with action `merge:${repoId}:${commitHash}`), merge.
merge must re-run app/lib/world/approve.ts itself (never trust the approval argument) and must check
PermissionRegistry stage < 2 for the prompter's AI use and stage < 3 for the validator.
Use the event's World ID for Agents dev environment (docs/DECISIONS.md Q8).
Test: approved -> merge called; cancelled/expired/denied -> merge never called.
```

### 🔵 CC-13 GitHub merge + receipt linkage *(Lane 4)*
```
app/lib/github/: create a branch + PR in the demo target repo with the agent's diff, compute the
commit/tree hash we bind approvals to, and merge only through the protected-branch path (the
hitl-gate status check must pass; no admin bypass). Store receiptId <-> PR <-> commit mapping.
Add a periodic audit job: list merged commits on main, flag any without a receipt as an incident
(unmarked merge). Tests with a mocked GitHub API.
```

### 🔵 CC-14 Enroll page *(Lane 5)*
```
app/(pages)/enroll: IDKit widget for Proof of Human, fallback button for Selfie Check, clear states for
success, cancelled, expired, already enrolled, credential unavailable. Show the resulting ENS name.
Start against a mocked /api/enroll until Lane 3 merges; keep the mock behind an env flag.
```

### 🔵 CC-15 Session page *(Lane 5)*
```
app/(pages)/session: prompt box -> agent proposal (diff viewer) -> Accept / Deny with new input
(shows round number; context resets each round) -> on Accept, the World ID approval widget
(<HumanApproval> or useHumanApproval per docs/DECISIONS.md Q1) + wallet signature of HumanApproval
-> result: receipt id, PR link, merge status. Every failure path has a visible, specific state.
```

### 🔵 CC-16 Forensics + directory pages *(Lane 5)*
```
app/(pages)/forensics: list receipts; "Was the validation right? Yes / No" with evidence text and
a major toggle (calls /api/forensics/audit); appeal and finalize buttons; live score/stage of the
validator; penalty token metadata (decode tokenURI).
app/(pages)/directory: org members and their agents resolved live from ENS (app/lib/ens/read.ts):
name, stage, score, hitl.* permissions, expiry. No hard-coded values.
```

### 🔵 CC-17 Merge gate *(Lane 6)*
```
Write a GitHub Action (gate/ + .github/workflows/hitl-gate.yml in the DEMO TARGET repo template)
that posts the required status check `hitl-gate`: success only if ValidationReceipts.canMerge(merger,
repoId, commitHash) is true AND the validator's ENS hitl.stage < 3. Read addresses from config;
RPC from secrets. Document the branch protection settings in docs/GATE.md.
```

### 🔵 CC-18 Tests end to end *(Lane 7)*
```
Playwright on a local stack (anvil + contracts deployed via CC-2 + app with mocked World ID):
1 happy path (enroll -> prompt -> deny -> accept -> approve -> receipt -> merge -> audit wrong ->
penalty -> stage shown), and failure paths: cancelled approval (no receipt, no merge), banned
validator (Banned), Selfie user on high-tier repo (rejected), replayed approval (rejected).
Add to CI.
```

### 🔵 CC-19 Deploy *(Lane 7)*
```
Deploy contracts to Sepolia with CC-2, verify them on Etherscan, commit config/11155111.json.
Run scripts/ens/setup-org.ts. Configure the hosted app env from .env.example (I will paste secrets
into the hosting dashboard myself; never print them). Smoke-test the live app against Sepolia and
write the results to docs/DEPLOY.md.
```

### 🔵 CC-20 Docs + final security pass *(Lane 7)*
```
Write README (what/why, architecture diagram, run locally, deploy, contract links), docs/TRUST.md
(trust moment = an AI agent merging into a protected branch; credential ladder: Proof of Human for
enrollment, Selfie Check capped fallback, session proof per approval, + presence for high tier;
why Passport is NOT used), docs/LIMITS.md (from AUDIT.md section 5).
Re-run forge test, fuzz and invariants, slither; review every new contract and external call since
AUDIT.md was written (publisher, enrollAttested, Selfie cap) and update AUDIT.md with findings,
fixes and regression tests. Finish docs/DEBRIEF.md from the log.
```

---

## 3. Checkpoints (merge only when these hold)
- [ ] `forge test` green; no new medium/high Slither findings; AUDIT.md updated for new code
- [ ] No secret in git history (gitleaks clean); no server key imported in a client component
- [ ] Every World ID result verified server-side; every failure path leaves no receipt and no merge
- [ ] ENS values come from resolution, never hard-coded; the gate reads ENS
- [ ] docs/DEBRIEF.md has timestamps and the four required sections
