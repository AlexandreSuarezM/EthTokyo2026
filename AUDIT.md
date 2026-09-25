# Security review — HITL accountability contracts

> **What this is and is not.** This review follows the method of a professional smart-contract
> audit: manual line-by-line review, static analysis, and property-based testing. It was
> performed by an AI assistant during development. **It is not a substitute for an independent
> audit by a security firm**, which you need before these contracts hold real value or run on
> mainnet.

## 1. Scope

**Revision 2 (task CC-1):** attested enrollment and key rotation in `HumanRegistry` (World ID 4.0
verified off-chain by the backend, co-signed with EIP-712), credential levels (Orb, Selfie), and the
Selfie cap on `REPO_TIER` in `PermissionRegistry`. New finding: L-05. New trust assumptions: C-08, C-09.
Paths are relative to `contracts/`.

| File | SHA-256 (first 16) | Notes |
|---|---|---|
| `src/HumanRegistry.sol` | `0ffa79bb4298eee6` | one human, one account; key rotation; on-chain or attested mode; credential level |
| `src/PermissionRegistry.sol` | `0001faeefff38e46` | expiring grants, presets, stage gating, Selfie tier cap |
| `src/ValidationReceipts.sol` | `0d20a241c29dca77` | receipts, forensics, appeals |
| `src/PenaltyLedger.sol` | `7370194ace4695f5` | verdict token, decaying score, stages |
| `src/WorldIDVerifier.sol` | `47cfbc9361772965` | World ID router adapter |
| `src/interfaces/*.sol` | `dfdc…`, `c4eb…`, `6674…` | interfaces |

1,312 lines in scope. Compiler: solc 0.8.28, `via_ir`, optimizer 200 runs, OpenZeppelin 5.1.0.

**Out of scope:**
- `src/mocks/` (test-only);
- `src/mirrors/ENSRoleMirror.sol` (ENSv1; to be replaced by the ENSv2 publisher);
- the off-chain orchestrator;
- World ID itself;
- OpenZeppelin libraries.

## 2. Method

1. **Manual review** of every function: access control, state transitions, arithmetic, external calls, reentrancy, signature handling, griefing, economic abuse, and trust assumptions.
2. **Static analysis:** Slither 0.11.6, all 99 detectors. Each result is triaged in section 6.
3. **Tests** (`forge test`): 75 tests, all passing:
   - 64 unit tests, including a regression test for every fixed finding;
   - 7 fuzz tests, 256 runs each;
   - 4 stateful invariants, 256 runs × 500 calls each (128,000 calls), with `fail_on_revert = true`.

## 3. Summary

| Severity | Found | Fixed | Mitigated | Acknowledged |
|---|---|---|---|---|
| High | 0 | – | – | – |
| Medium | 3 | 3 | – | – |
| Low | 5 | 4 | 1 | – |
| Informational | 5 | 3 | – | 2 |
| Centralization / trust | 9 | – | – | 9 |

## 4. Findings

### M-01 Self-judging through an unenrolled role holder — **Fixed**
`ValidationReceipts._rule` skipped the "not your own receipt" check when the forensics account was not an enrolled human. A validator could have the forensics role granted to a second, unenrolled address and rule their own receipt "correct", escaping any penalty.
**Fix:** ruling requires an enrolled human (`NotEnrolled`), and humans are compared, not addresses. World ID allows one account per human, so a sock-puppet address can't rule.
**Tests:** `test_M01_UnenrolledForensicsCannotRule`, `test_ForensicsCannotAuditOwnReceipt`.

### M-02 A validator could resolve their own appeal — **Fixed**
`resolveAppeal` only checked that the reviewer was not the judge's *address*. A validator holding `APPEALS_ROLE` could overturn their own penalty, and the judge could hear their own appeal from a second address.
**Fix:** the reviewer must be an enrolled human, different from the validator (`OwnReceipt`) and from the judge (`SameReviewerAsJudge`), compared by human.
**Test:** `test_M02_ValidatorCannotResolveOwnAppeal`.

### M-03 Fee pulled from a stored payer allowed allowance draining — **Fixed** (Slither: `arbitrary-send-erc20`)
`validate` pulled fees from `repo.payer`. Any insider allowed to validate could spam receipts for random hashes and drain the organization's approved allowance to the platform treasury.
**Fix:** the fee is paid by `msg.sender`, whoever submits the transaction. The `payer` field was removed.
**Test:** `test_M03_FeePaidBySubmitterOfTx`.

### L-01 Fade-rate rounding made penalties outlast the stated period — **Fixed**
The decay rate was rounded down (`base·1e18 / fadePeriod`), so one minor penalty stayed above zero for up to 1 s past `fadePeriod`. `test_OneMinorMistakeFadesInOneMonth` caught it. The fuzz test at the time tolerated the leftover dust, so it has been tightened to require exactly zero.
**Fix:** the rate is rounded up. A penalty now never outlasts its stated fade period (`testFuzz_SingleMinorFadesWithinPeriod`).

### L-02 State write after external call in `penalizeBaselessFlag` — **Fixed** (Slither: `reentrancy-no-eth`)
The strike counter was reset after `_suspend`, which calls the (admin-set) mirror.
**Fix:** state is written first, and the mirror call is gas-capped at 300,000.

### L-03 Permissionless `finalize` can starve the score publisher of gas — **Mitigated**
The publisher call is gas-capped inside `try/catch`, so a caller can supply just enough gas for the penalty to land while the publisher call runs out of gas. The ENS mirror is then stale; the on-chain score is still correct.
**Mitigation:** a `PublishFailed` event, plus a permissionless `republish(human)` that anyone can call to repair it. A hostile or broken publisher can never block a penalty.
**Test:** `test_BrokenPublisherNeverBlocksPenalty`.

### L-04 Zero treasury with a fee token set — **Fixed** (Slither: `missing-zero-check`)
Setting a fee token with `treasury = 0` made every validation revert, since OpenZeppelin tokens refuse transfers to zero.
**Fix:** `setFees` reverts with `ZeroTreasury`.
**Test:** `test_L_ZeroTreasuryRejected`.

### L-05 Two enrollment paths would give one person two accounts — **Fixed** (design review, revision 2)
The on-chain path derives `humanId` from the World ID 3.x nullifier; the attested path takes the `humanId` the backend derives from a World ID 4.0 proof. The two values differ for the same person, so "one human, one account" holds within a path but not across them: with both paths open, a person could enroll one key on-chain and a second key through the attester, and hold two scores.
**Fix:** the paths are exclusive, switched by the same setting as `ValidationReceipts`: `attester == 0` allows only `enroll`/`rotateKey` (`OnChainMode` otherwise); a nonzero attester allows only `enrollAttested`/`rotateKeyAttested` (`AttesterMode` otherwise). What remains, switching modes after people have enrolled, is recorded as C-08.
**Test:** `test_L05_EnrollModesAreExclusive`.

### I-01 Interfaces not inherited — **Fixed**
`PenaltyLedger` now inherits `IPenaltyMinter` and `IPenaltyStages`, so a signature drift fails at compile time rather than at runtime.

### I-02 `secondsUntilBelow(human, 0)` returned 1 — **Fixed**
Nothing is strictly below zero, so it now returns `type(uint256).max`.

### I-03 Unindexed address events — **Fixed**

### I-04 `submitter` is asserted by the validator — **Acknowledged**
The prompter recorded in a receipt comes from the validator's signed data and is not independently verified. No penalty depends on it today, so the impact is limited to data integrity.
**Recommendation:** have the orchestrator co-sign the session record.

### I-05 `canMerge` loops over every receipt for a commit — **Acknowledged**
It is a view function, and the loop is bounded by the number of distinct validators of one commit. It is safe for CI use.

### Test-suite finding: vacuous invariant — **Fixed**
After M-01's fix, the invariant handler's `forgive` calls reverted, because the handler wasn't enrolled. The invariants still passed, because the runner ignored reverts.
**Fix:**
- `fail_on_revert = true`;
- a new invariant, `invariant_ForgivenessActuallyExercised`;
- the handler is enrolled.

## 5. Centralization and trust assumptions (acknowledged)

These are design choices, not bugs. For a production deployment, put `DEFAULT_ADMIN_ROLE` behind a **multisig with a timelock**, and give the ruling roles to different people.

| ID | Assumption | Consequence if abused |
|---|---|---|
| C-01 | Admin can change penalty config | New **stage thresholds apply to existing scores immediately**, so the admin could ban or unban everyone at once. Decay rates are snapshotted per account and never change retroactively. |
| C-02 | Admin can change the liability and appeal windows | Shrinking the window shields past validations; widening it re-exposes them |
| C-03 | An evaluator can forgive any amount in one call | One evaluator can clear a ban. Mitigations: must be enrolled, can't forgive themselves, must give a reason, and the event is permanent. Consider a per-call cap or two evaluators. |
| C-04 | Forensics rulings are trusted | One judge plus a different appeals reviewer. No panel. |
| C-05 | Admin chooses who holds roles | The contracts enforce "enrolled human" and "not your own case", not who is competent |
| C-06 | The attester (backend) is trusted in attester mode | The attester can't mint alone, since the validator's signature is also required, but it could co-sign without really verifying World ID. On-chain mode instead relies on World ID 3.x nullifier semantics. |
| C-07 | `rotateKey` needs only a World ID proof | Compromising a person's World ID means taking over their account (and their score follows) |
| C-08 | Admin can switch the enrollment mode (`setAttester`) | Humans enrolled in one mode keep their `humanId`; if the same person enrolls again after a switch, the other derivation gives them a second account (L-05). Pick one mode per deployment and don't switch once people have enrolled. |
| C-09 | The attester (backend) is trusted for identity in attested mode | Unlike C-06, the attester acts **alone** here: a leaked or dishonest attester key can enroll unlimited fake humans at any credential level, and can move any human's account to a key it controls with `rotateKeyAttested`, since no signature from the old key is needed. Mitigations in place: signatures name the account (no front-running), expire, can't be replayed (used-digest set), and every change emits `EnrolledAttested` / `KeyRotatedAttested`. Keep the key server-only (ideally in a KMS/HSM), monitor those events, and consider a delay on attested rotation during which the old key can cancel. |

## 6. Slither results after fixes (17, all triaged)

Slither 0.11.6, run from `contracts/` with `--filter-paths "<abs>/lib|<abs>/test|<abs>/src/mocks"`. Revision 2 added two
results (the `setAttester` zero-check and `_isSelfie` in the loop, below) and no Medium or High ones: the two
`unused-return` results are the existing `perms.policy()` destructurings, now with one more field.
Results in `src/mirrors/` (out of scope), `timestamp` and `naming-convention` are not listed.

| Detector | Location | Verdict |
|---|---|---|
| `incorrect-equality` ×3 | `scoreOf`, `_stageFor`, `secondsUntilBelow` | Intended `== 0` checks on values not controlled by an attacker. False positive. |
| `uninitialized-local` ×2 | `canMerge` `valid`, `solo` | Zero by default, as intended. False positive. |
| `unused-return` ×2 | `perms.policy()` destructuring | Intended: only one field is needed. |
| `missing-zero-check` ×2 | `ValidationReceipts.setConfig._attester`, `HumanRegistry.setAttester._attester` | Zero means on-chain mode, intended. |
| `calls-loop` ×5 | `canMerge`, `activeValue`, `_sync`, `_checkGranter`, `_isSelfie` | Trusted contracts; views or admin-bounded loops. `_isSelfie` reads the immutable `HumanRegistry` and compares against a compile-time constant. |
| `missing-inheritance` | `PermissionRegistry` / `IPenaltyStages` | It exposes `stageOf` for convenience but is not a stage source; inheriting would invite wiring it in as one. Intended. |
| `reentrancy-events` ×2 | `_issuePenalty`, `_publish` | Events after a call to trusted/gas-capped contracts; state is written first. No impact. |
| `timestamp` (excluded from list) | several | Windows are days long; validator timestamp drift of a few seconds is irrelevant. |

## 7. Properties verified

| Property | Evidence |
|---|---|
| No token at validation | `test_ValidationRecordsReceiptAndMintsNoToken` |
| Penalty only through forensics on a real receipt | `test_OnlyReceiptsContractCanMint`, `test_AuditRequiresEvidenceAndWindowAndRealReceipt`, `test_MinterGuards` |
| One penalty per receipt | `test_MinterGuards` (`AlreadyPenalized`) |
| Minted without consent; a contract wallet can't refuse | `test_AuditWrongMintsPenaltyToValidator`, `test_ContractWalletCannotRefusePenalty` |
| Non-transferable, non-burnable | `test_PenaltyIsNotTransferableOrBurnable` |
| Escalation: each repeat weighs more | `test_RepeatMistakesEscalateToBanAndCap`, `testFuzz_EscalationGrowsFast` |
| Hard cap; no overflow even with extreme configs | `test_CapHolds`, `testFuzz_ScoreNeverExceedsCap`, `testFuzz_ExtremeConfigNoOverflow`, `invariant_ScoreWithinCap` |
| Fade: one minor mistake is gone in exactly one period; decay never increases | `test_OneMinorMistakeFadesInOneMonth`, `testFuzz_SingleMinorFadesWithinPeriod`, `testFuzz_DecayIsMonotone` |
| Stages match score; lift by themselves | `invariant_StageMatchesScore`, `test_BanLiftsByItself` |
| Stage 2 blocks AI only; stage 3 blocks everything | `test_Stage2BlocksAIOnly`, `test_Stage3Bans` |
| Forgiveness bounded, reasoned, never your own | `testFuzz_ForgiveBounded`, `test_ForgiveGuards`, `test_M_UnenrolledEvaluatorCannotForgive` |
| Config changes don't rewrite past decay | `test_ConfigChangeIsNotRetroactive` |
| Due process before penalty; separate human hears the appeal | `test_PenaltyWaitsForAppealWindowThenFinalizes`, `test_AppealOverturnedByDifferentReviewer`, `test_M02_…` |
| Signatures can't be replayed, tampered with or reused across approvals | `test_ReplayAndDuplicateBlocked`, `test_TamperedApprovalFails`, `test_AttesterModeNeedsBothSignatures` |
| Score follows the human across key rotation | `test_KeyRotationKeepsScore`, `test_AttestedRotationKeepsLevelScoreAndPermissions` |
| Attested enrollment: only the attester's signature, only for the named account, before the deadline, once | `test_AttestedEnrollHappyPath`, `test_AttestedEnrollWrongAttesterReverts`, `test_AttestedEnrollIsBoundToSender`, `test_AttestedEnrollTamperedLevelReverts`, `test_AttestedEnrollExpiredReverts`, `test_AttestedEnrollReplayReverts` |
| One human, one account in attested mode too; one mode at a time | `test_SecondAccountForSameHumanReverts`, `test_EnrolledAccountCannotEnrollAgain`, `test_L05_EnrollModesAreExclusive` |
| Attested rotation can't be replayed to move a human back to an old key | `test_AttestedRotationReplayReverts`, `test_AttestedRotationGuards` |
| Selfie humans never exceed `maxTierForSelfie`, at grant or at read, and lowering the cap applies at once | `test_SelfieCapEnforcedInValidate`, `test_GrantAboveSelfieCapReverts`, `test_SelfieCapLoweredTakesEffectAtOnce`, `testFuzz_SelfieTierNeverAboveCap`, `test_OrbHumanIsNotCapped` |

## 8. Economics of the default rulebook

Defaults (`team-default`): base 100, major ×2, +100 % of current score, cap 1000, no AI at 200, banned at 500; one base (100 points) fades per 30 days.

| Sequence (same day) | Score | Stage | Time until the ban lifts | Time until clean |
|---|---|---|---|---|
| 1 minor | 100 | 1 score | – | 30 days |
| 2 minor | 300 | 2 no AI | – | 90 days |
| 3 minor | 700 | 3 banned | 60 days | 210 days |
| worst case (cap) | 1000 | 3 banned | 150 days | 300 days |

"Fades over one month" holds per mistake; stacked mistakes fade proportionally longer. This is the "hits hard, fades slowly, grows fast" behavior you specified. If recovery after a ban should be shorter, lower `fadeDays` or `stage3At`.

## 9. Before mainnet

1. An independent audit by a security firm.
2. Admin behind a multisig and timelock (C-01, C-02); ruling roles held by different people.
3. Decide on C-03 (cap forgiveness per call, or require two evaluators).
4. Review the ENSv2 score publisher when it's written; it is the only planned new external call.
5. Replace the World ID 3.x on-chain path with attester mode (World ID 4.0), and review the attester service itself.
6. Attested mode (C-09): keep the attester key in a KMS/HSM, alert on `EnrolledAttested` and `KeyRotatedAttested`, and decide on a cancelable delay for attested key rotation. Don't switch enrollment modes after launch (C-08).
