# HITL Attest — design

A human validates AI output; the validation is recorded; if forensics later proves it wrong,
the validator receives a non-transferable **penalty token** and a score that escalates, fades,
and restricts what they may do. Security review: see `AUDIT.md`.

## 1. Flow

```
users enroll (World ID: one human = one account)
      │
prompt ─► AI output ─► validator: deny (new input, context rebuilt) ─┐
                                 │                                  └──► back to prompt
                                 └─ accept ─► human proof at this moment ─► RECEIPT (no token)
                                                                              │
                                  later: forensics audit ("was it right?") ◄─┘
                                        │ right ─► cleared, nothing minted
                                        │ wrong ─► appeal window ─► (appeal: a different human decides)
                                        ▼
                               PENALTY TOKEN minted to the validator
                               score += escalating weight (capped), fades over time
                               stage 1: score published (ENS) · 2: no AI access · 3: banned
```

## 2. Contracts

| Contract | Role |
|---|---|
| `HumanRegistry` | World ID enrollment: one human, one account. Key rotation keeps the same `humanId`. Two exclusive modes: on-chain (World ID 3.x proof) or attested (the backend verifies World ID 4.0 and co-signs an EIP-712 message). Records the credential level: Orb or Selfie. |
| `PermissionRegistry` | Expiring permissions (repo tier, change size, AI quota, merge, grant, flag), presets, repos, policy. **Reads** the penalty stage: stage 2 turns AI quota off, stage 3 turns every permission off. A Selfie-level human's repo tier is capped at `policy.maxTierForSelfie`. |
| `ValidationReceipts` | Validation receipts, forensics audits, flags, appeals, merge gate. Calls the ledger only when due process has ended. |
| `PenaltyLedger` | The verdict token (soulbound ERC-721/5192) and the decaying score. |
| `WorldIDVerifier` | World ID router adapter (swappable). |

## 3. The penalty token

| Property | Rule |
|---|---|
| **When** | Only when forensics confirms a validation was wrong, after the appeal window or a confirmed appeal |
| **Who mints** | Only the receipts contract (`MINTER_ROLE`), which requires a designated forensics account that is an enrolled human, a real receipt, evidence, the liability window, and not the forensic's own receipt |
| **To whom** | The validator's current account, without their consent (`_mint`, so contract wallets can't refuse) |
| **Transfer** | Impossible: transfer, approve, operator approval and burn all revert (ERC-5192 locked) |
| **Record** | Receipt id, evidence hash, severity, effective weight, date. Permanent; the effect fades, the record doesn't |
| **One per receipt** | A receipt can be penalized once |

### Score
```
weight = base × (major ? majorMultiplier : 1) + currentScore × escalation%
score  = min(score + weight, maxScore)            # cap: no overflow, bounded worst case
decay  = base points per fadePeriod, linear       # one minor mistake fades in exactly one period
```
Repeated mistakes grow fast, because the current score feeds the next weight, and a stack takes proportionally longer to fade. Each account snapshots its decay rate, so config changes never rewrite past decay.

### Stages (your rulebook)
| Stage | Condition | Effect |
|---|---|---|
| 0 | score = 0 | clean |
| 1 | score > 0 | losing score, to be published on ENS (publisher hook in place; the ENSv2 implementation is Phase 3) |
| 2 | score ≥ `stage2At` | no AI access (`AI_SUBMIT` inactive) |
| 3 | score ≥ `stage3At` | banned: cannot validate, prompt, flag, grant or merge |

Stages lift by themselves as the score fades. An **evaluator** (an enrolled human, never forgiving themselves, always with a reason) can forgive points to speed recovery. The token records stay.

Default numbers and recovery times are in `AUDIT.md` §8.

## 4. Receipts and due process

| Transition | Who | Condition |
|---|---|---|
| `validate` | anyone relays; the validator signs | enrolled; permissions; not banned; human proof (on-chain World ID, or backend attestation of World ID 4.0) |
| `audit(receipt, correct, evidence, major)` | forensics (enrolled human) | evidence; liability window; not their own receipt |
| `flag` → `resolveFlag` | anyone with FLAG → forensics | same checks; a rejected flag gives the flagger a flag strike |
| `appeal` | the validator | once, within the appeal window |
| `resolveAppeal` | appeals role; a human different from the validator and the judge | confirm → penalty; overturn → no penalty |
| `finalize` | anyone | Missed, no appeal, window over → penalty |

## 5. Environments

`/environments/*.json`: `policy` (live-proof tier, self-validation, flag abuse), `receipts` (liability and appeal windows, attester), `penalties` (base, major multiplier, escalation %, cap, stage thresholds, fade days), `repos`, `presets`, `fees`. `node orchestrator/check-envs.js` verifies all of them.

## 6. Not built yet

- ENSv2 score publisher and permission records (Phase 3)
- Backend attester service for World ID 4.0 + human-in-the-loop SDK (Phase 4); the contract side (attested enrollment, rotation and validation) is in place
- `mirrors/ENSRoleMirror.sol` is ENSv1 and out of audit scope; it will be replaced
