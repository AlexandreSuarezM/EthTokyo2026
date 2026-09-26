# Debrief

## Time to first success

- **2026-09-26 — RP signing (CC-8):** from reading the IDKit integrate page to a server-side `signRequest` whose
  signature recovers to our key in a unit test: under an hour. The pure-JS signer (no WASM) made testing easy.

## Integration friction

- **2026-09-25 — ENSv2 beta:** the ENSv2 beta app link failed, so we could not register a name through it.
  With the deadline close and the beta unstable, ENS was deferred (target prizes are now World IDKit and
  World ID for Agents only).
- **2026-09-26 — Node 22 SQLite:** `node:sqlite` works for local storage without native builds, but prints an
  "experimental" warning on every run. Deployment uses Neon Postgres instead.

## Missing or unclear docs

- **2026-09-25 — World Developer Portal:** the portal has no settings for actions or credentials; both are
  set in code (the IDKit request), not configured in the dashboard as our plan (H1) assumed.
- **2026-09-26 — RP signatures:** the signatures page imports `signRequest` from `@worldcoin/idkit-server`,
  the integrate page from `@worldcoin/idkit-core/signing`. Both work (the second re-exports the first),
  but neither page says so. The signatures page also doesn't show the `rp_context` object IDKit expects
  (`rp_id`, `nonce`, `created_at`, `expires_at`, `signature`); only the integrate page does.
- **2026-09-26 — Session requests:** that session requests are signed without an action is stated on the
  session-proofs page and in the `signRequest` type comments, not on the signatures page.
- **2026-09-26 — Sessions vs uniqueness (CC-9):** the session-proofs page says a session "is not" a uniqueness
  proof, so one-person-one-account needs two proofs at enrollment (a uniqueness proof, then `createSession`).
  The page only shows `createSession` with `selfieCheck()`; that `proofOfHuman()` also works there is only
  in the IDKit type comments. Nothing says whether two `createSession` calls by one person give the same
  `session_id`.
- **2026-09-26 — Verify response for sessions:** the API reference lists `action`, `nullifier` and
  `session_id` as optional without saying which proof type returns which. We require `action` + `nullifier`
  for uniqueness proofs and `session_id` for session proofs, and fail closed otherwise; to confirm with a
  real proof.
- **2026-09-26 — Binding a proof to a wallet:** `signal_hash` is optional in the result types. We always set a
  signal (the wallet for the uniqueness proof, the pending enrollment for the session) and reject results
  without it. The docs don't say whether the verify API checks the proof against the `signal_hash` we
  forward, or only that it's well-formed.

- **2026-09-26 — Staging is closed by default (CC-10):** a staging verify call to `/api/v4/verify/{rp_id}` returns
  `403 {"code":"environment_not_allowed","detail":"Staging verification is not open for this app. Open a staging
  window with the set_world_id_staging_verification tool, ..."}`. Neither the IDKit integrate page nor the verify
  API reference mentions this 403 or the tool; the integrate page only says to use the simulator with
  `environment: "staging"`. The explanation is in the developer-portal repo (PR #2307, merged 2026-09-25): an
  authenticated MCP tool opens a 24h staging window per app and issues a one-time token. We build production-only
  for now, so the simulator can't give us extra test humans.

## What worked well
