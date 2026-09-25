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

**Assumption:** because it's a request-level flag, we set it on `proveSession` for repos with
tier >= `liveProofTier`, and the server requires `user_presence_completed === true` in the verified payload.
If IDKit rejects the flag on a session request, high-tier approvals fail closed (no receipt, no merge), and
we log it in `docs/DEBRIEF.md`.

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

From the [ETHGlobal Tokyo 2026 prizes page](https://ethglobal.com/events/tokyo2026/prizes), not the World docs:
- **URL:** docs <http://sandbox.auth.world.org/docs>, portal <http://sandbox.auth.world.org/portal>;
  agent plugin <https://github.com/worldcoin/world-id-agent-plugin>.
  The prize requires integrating "with the official World ID for Agents on dev environment provided for the event".
- **App id:** the environment's docs say you "manage your OIDC client in the portal", so a client registration
  in that portal is required. It is an OIDC client, not a Developer Portal `app_id`.
- **Mocked proofs:** the prize page says "We are mocking proofs now, so you don't need sandbox app anymore"
  and "Proofs are using fake identities". **Which proofs are mocked is not documented.**

**This differs from BUILD_PLAN CC-12.** The event environment is an OpenID Connect identity provider
("World ID Human Continuity": authorization code flow, fresh authentication, device authorization grant,
agent authorization through an MCP server). It doesn't mention `@worldcoin/human-in-the-loop` or IDKit.
**Assumption, to confirm with World organizers before CC-12:** the agent's approval step must go through this
environment (fresh authentication or device authorization with human approval) to qualify for the prize.
IDKit stays in use for enrollment and the Selfie fallback (IDKit prize).

## ENSv2 (names, resolver, registry addresses)

Out of scope (ENS cut, see `docs/RULES.md`). Q5–Q7 are not answered.

## Networks and addresses

Sepolia. Addresses come from `config/<chainId>.json`, written by `contracts/script/Deploy.s.sol`.

## Agent and model

See Q1, Q4 and Q8.

## Storage (DATABASE_URL)

`DATABASE_URL=file:./dev.db` (SQLite) locally, Neon Postgres when deployed. Tables: nullifiers (unique on
action + nullifier, stored as decimal strings), sessions, consumed approvals (unique key).

## Open questions

- Q1/Q2: does the HITL SDK or IDKit support `proveSession` with `require_user_presence`? Ask World at the event.
- Q8: must the agent's approval use the `sandbox.auth.world.org` OIDC environment instead of the HITL SDK? Ask the organizers.
- Cross-org identity (one World ID app for all orgs or one per org): not decided.
