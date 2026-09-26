# HITL Attest: human review of AI code, with skin in the game

AI writes code and a human clicks "approve". When that approval is wrong, nobody is accountable.
**HITL Attest** makes every review a signed, on-chain act by **one verified human (World ID)**. Each review earns a
soulbound **reward token**; approving code that fails lets the judge **slash every token**. A **bounty** pays its
prize only to reviewers who earned 5 tokens, and tokens come slowly (one per cooldown, shared across bounties), so
the system pays for careful review, not fast clicking.

Built for ETHGlobal Tokyo 2026 (World ID). Live on **Sepolia**. Open source under the [MIT license](LICENSE).

## 60-second demo

Run the app (below), open http://localhost:3000/demo with MetaMask on Sepolia:

1. **Connect** and **Enroll with World ID** (one human = one account, recorded on-chain).
2. **Spawn code sample**: the "AI" serves a C hello world, right or wrong (50/50). The verdict is sealed on the
   server as `hash(code, verdict, salt)` before you see it.
3. Decide: **✓ Approve** (signed, recorded as a receipt on-chain) · **✗ Report** (signed) · **⏭ Skip** (nothing).
4. The **judge** reveals the verdict and proves it wasn't changed ("fingerprint matches ✓" against the receipt).
5. Every review earns **+1 reward token** (at most one per 30 s). **Approving code that fails slashes all tokens.**
6. At **5 tokens**, **Qualify** for the bounty; qualified reviewers **Claim** an equal share of the prize.

| Code | You press | Result |
|---|---|---|
| works | Approve | +1 token |
| works | Report | +1 token |
| fails | Report | +1 token |
| fails | Approve | +1 token, then **all tokens slashed** |
| any | Skip | nothing |

Tip: the correct program prints `"Hello world!\n"`; every wrong one prints without `\n`.

## How it works

```
YOU (browser + MetaMask)          SERVER (Next.js)                          SEPOLIA
Enroll ─────────────────────────► attester signs "wallet = 1 human" ─────► HumanRegistry.enrollAttested
Spawn code sample ──────────────► coin flip; verdict + salt stay here
Report (sign) ──────────────────► checks your signature; judge awards ───► Bounty.award → RewardToken.mint
Approve (sign) ─────────────────► relayer submits your signed approval ──► ValidationReceipts.validate (receipt)
                                  judge reveals, checks the fingerprint ◄─ receipt.contextHash
                                  +1 token; code failed → slash all ────► Bounty.award / RewardToken.slash
Qualify / Claim (tx) ────────────────────────────────────────────────────► Bounty.optIn / Bounty.claim
```

- **`RewardToken`**: soulbound (no transfer function at all), keyed by the human, one shared cooldown per human
  across all bounties, minted only by bounties, slashed by the judge or the owner.
- **`Bounty`**: the challenge code (`codeHash` + `codeURI`), the prize, +1 token per reviewed sample, qualify at 5
  (final: a later slash keeps the seat), equal split, owner refund if nobody qualifies.
- **`HumanRegistry`**: World ID enrollment, one human = one account; `ValidationReceipts`: signed approvals as
  receipts; `PenaltyLedger` + `PermissionRegistry`: an accountability ladder (restrictions → ban), built and tested,
  not used in this demo.

### Why a judge, and why it stays honest

The judge is a server key: it generated the sample, so it knows the answer. It **can't change a verdict after the
fact** (the verdict is sealed in the receipt before the user decides and revealed afterwards). It can still award or
slash. We accept that as an equilibrium: a user slashed for a real mistake is following the rules; a corrupt judge
quickly loses the reviewers' attention, and a bounty nobody reviews pays nobody. Hardening options (permissionless
slashing by hash, challenge windows, judge panels, bonds) are listed in [docs/DECISIONS.md](docs/DECISIONS.md).

## Sepolia contracts

| Contract | Address |
|---|---|
| Bounty (code link + prize) | [0x882C6095C009EE63EB725B28C590034ae19F75A3](https://sepolia.etherscan.io/address/0x882C6095C009EE63EB725B28C590034ae19F75A3) |
| RewardToken (soulbound, cooldown, slash) | [0xD5CDd7f50fb022ea0403ECbeC8F2C7F1a4cFBeae](https://sepolia.etherscan.io/address/0xD5CDd7f50fb022ea0403ECbeC8F2C7F1a4cFBeae) |
| HumanRegistry | [0x35d619cFb1a86DC537d42EE495c36f0c46Af4d30](https://sepolia.etherscan.io/address/0x35d619cFb1a86DC537d42EE495c36f0c46Af4d30) |
| ValidationReceipts | [0xF292d62DEa44171D883e2873d3D0688e6CBbD8De](https://sepolia.etherscan.io/address/0xF292d62DEa44171D883e2873d3D0688e6CBbD8De) |
| PermissionRegistry | [0x32E48C4492457152DaB31bD2b37A83223C1a0eC0](https://sepolia.etherscan.io/address/0x32E48C4492457152DaB31bD2b37A83223C1a0eC0) |
| PenaltyLedger (not used in the demo) | [0xA4730F419bea45Cd9afA538CAf36e23ec45AD679](https://sepolia.etherscan.io/address/0xA4730F419bea45Cd9afA538CAf36e23ec45AD679) |
| Judge / relayer | [0x99fa6dc0ea8eE05816EF79b0380a7AfA68088328](https://sepolia.etherscan.io/address/0x99fa6dc0ea8eE05816EF79b0380a7AfA68088328) |

Addresses are read by the app from [`config/11155111.json`](config/11155111.json) and
[`config/11155111.bounty.json`](config/11155111.bounty.json); nothing is hard-coded.

## Layout

```
contracts/src/      Bounty, RewardToken, HumanRegistry, ValidationReceipts, PermissionRegistry, PenaltyLedger, WorldIDVerifier
contracts/test/     Foundry unit, fuzz and invariant tests (110)
contracts/script/   Deploy.s.sol (core + preset), DeployBounty.s.sol (RewardToken + Bounty)
app/                Next.js: /demo page, API routes, World ID verification, attester, relayer, judge (151 tests)
app/demo-data/      the fake AI's C hello-world samples (1 correct, 4 with one mistake)
config/             deployed addresses per chain
environments/       rule presets (demo.json is the one on Sepolia)
docs/               DECISIONS, LIMITS, DEBRIEF, PRESENTATION, STATUS, DEMO_PLAN
```

## Run locally

Requires Node 22+ and, for the contracts, Foundry (`forge`, `anvil`).

```bash
git clone --recurse-submodules https://github.com/AlexandreSuarezM/EthTokyo2026.git

cd contracts && forge build && forge test      # 110 tests
cd ../app && cp ../.env.example .env.local     # fill in values (never commit them)
npm install && npm test                        # 151 tests
npm run dev                                    # http://localhost:3000/demo
```

`WORLD_ID_MODE=real` (default) verifies World ID proofs on the server; `WORLD_ID_MODE=simulated` skips the proof
for demos, shows a yellow badge, and enrolls at a distinct on-chain level that is never Orb.

## Deploy to Sepolia

From `contracts/`, with `SEPOLIA_RPC_URL` and a funded deployer:

```bash
# core contracts + the demo preset (judge = OPERATOR = relayer); writes config/11155111.json
HITL_ENV=demo ATTESTER=<attester address> OPERATOR=<relayer address> \
  forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --account deployer --broadcast

# RewardToken + Bounty; writes config/11155111.bounty.json
JUDGE=<relayer address> BOUNTY_CODE_HASH=<keccak256 of the challenge code> BOUNTY_CODE_URI=<link> \
BOUNTY_FUND_WEI=10000000000000000 TOKEN_COOLDOWN=30 BOUNTY_THRESHOLD=5 \
  forge script script/DeployBounty.s.sol --rpc-url $SEPOLIA_RPC_URL --account deployer --broadcast
```

## Adding more judges

Judges hold `JUDGE_ROLE` on the Bounty (award) and the RewardToken (slash). The admin adds or removes one with:

```bash
cd contracts
JUDGE_ADDRESS=0x... JUDGE_ACTION=grant   forge script script/ManageJudge.s.sol --rpc-url $SEPOLIA_RPC_URL --account deployer --broadcast
# JUDGE_ACTION=revoke to remove one
```

A judge then calls `award(human, sampleId)` / `slash(human, reason)` from their own wallet. Test:
`test_Bounty_SeveralJudgesCanBeAddedAndRemoved`.

## Honest limits

- The demo runs `WORLD_ID_MODE=simulated` for recording; the real World ID flow is built and passed with a real
  proof on our test page. See [docs/DEBRIEF.md](docs/DEBRIEF.md) for the integration story.
- The judge is trusted to award and slash (see above). The "AI" is a set of files, not an LLM. One user.
- Security review: [AUDIT.md](AUDIT.md) (AI-assisted, not a professional audit). Limits: [docs/LIMITS.md](docs/LIMITS.md).

## Next steps

Per-bounty difficulty (each bounty sets its own cooldown while the token keeps one shared clock), a real agent
proposing code, real World ID sessions per review, several judges, and ENS-published reputation.

## Secrets

Real values live only in `app/.env.local` (git-ignored); [.env.example](.env.example) lists the names. Commits are
scanned with gitleaks locally and in CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)).
