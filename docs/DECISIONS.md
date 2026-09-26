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

## Agent and model

See Q1, Q4 and Q8.

## Storage (DATABASE_URL)

`DATABASE_URL=file:./dev.db` (SQLite) locally, Neon Postgres when deployed. Tables: nullifiers (unique on
action + nullifier, stored as decimal strings), sessions, consumed approvals (unique key).

## Open questions

- Q1: does the HITL SDK (or IDKit through it) support `proveSession`? Ask World at the event.
- Q8: pending organizers (dev environment URL, app id, which proofs are mocked).
- Cross-org identity (one World ID app for all orgs or one per org): not decided.
