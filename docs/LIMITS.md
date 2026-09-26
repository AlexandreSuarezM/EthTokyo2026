# Limits

## Security assumptions

- **Demo: the oracle is the relayer.** In `environments/demo.json` the address that penalizes wrong approvals
  (`ORACLE_ROLE`) is the relayer, the same server key that submits `validate()`. Whoever controls that key can
  penalize any validator's real receipt inside the 365-day liability window (once per receipt, with an evidence
  hash, recorded on-chain). Acceptable for a single-user demo only; in production the oracle role stays unset or
  goes to a separate, monitored key (AUDIT C-10).
- **Demo: the judge is the relayer, for minting and for lifting.** The same server key holds `ORACLE_ROLE`
  (penalize) and `JUDGE_ROLE` (lift a restriction early). It can't undo a ban (3 tokens) or delete a token, but it
  can lift any restriction and penalize any real receipt in the window (AUDIT C-10, C-12).
- **Demo: the server holds the admin (deployer) key** to grant the "validator" preset once per newly enrolled user
  (`PermissionRegistry.applyPreset`). In production an admin or a sponsoring human with `GRANT` does this by hand.
- **Demo: standing is partly read from our database.** Token ids and lift transactions come from what the judge
  recorded (the free-tier RPC can't scan logs); scores, stages, counts, bans and mint times are read on-chain.
- **Demo: `WORLD_ID_MODE=simulated` proves no humanity.** Simulated humans are enrolled without a World ID proof.
  They are marked on-chain (credential level 3, never Orb, capped like Selfie) and every API response says
  `simulated: true`, but nothing stops one person from enrolling several simulated wallets (AUDIT C-11).

## Known limitations

- **World ID 4.0 needed for the real mode.** The only real World ID we have returns `credential_unavailable` for a
  4.0 Proof of Human request, and sessions exist only in 4.0, so the demo runs `WORLD_ID_MODE=simulated`.
- **No appeals UI, no evaluator, one human.** The contracts support them (tested); the demo doesn't show them.
  `demo.json` sets the appeal window to 0, so an oracle ruling mints the penalty at once.

## Out of scope

## Before mainnet
