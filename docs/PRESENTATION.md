# Presentation guide: follow along

For whoever records the video and presents live. Everything runs on **Sepolia** from
**http://localhost:3000/demo**. Keep this file open on a second screen.

---

## 1. The pitch in 3 sentences

1. AI agents now write code, and a human clicks "approve"; when that approval is wrong, nobody is accountable.
2. We make every approval a signed, on-chain **receipt** from one verified human (World ID), and a judge that knows
   the right answer later mints a **soulbound penalty token** to whoever approved wrong code: restrictions grow,
   three strikes is a permanent ban.
3. Good validators earn soulbound **reward points** (slowly, one per cooldown) and qualify for a prize pool, so the
   system pays for careful review, not just punishes careless review.

---

## 2. Before you start (10 minutes)

| # | Check | How |
|---|---|---|
| 1 | Dev server running | `cd app && npm run dev` → open http://localhost:3000/demo, the yellow **World ID: simulated** badge shows |
| 2 | MetaMask on **Sepolia** | two accounts: **A = `0x5956…e83b`** (rewards) and **B = `0x86f7…e83b`** (ladder, ends banned) |
| 3 | Gas | each account ≥ 0.005 Sepolia ETH; relayer `0x99fa…8328` ≥ 0.01 (ask Claude to check: "check balance") |
| 4 | Browser | zoom **125 %**, close other tabs, dark/light as you like, hide bookmarks bar |
| 5 | Recorder | **Win + Alt + R** start/stop; files in `Videos\Captures`; rename right away (`01-enroll.mp4` …); < 30 s each |
| 6 | Etherscan tab | https://sepolia.etherscan.io open, to click links live |

**Golden rules while recording**
- A **ban is forever per wallet**. Only account **B** goes to 3 tokens. Record rewards with **A** first.
- Every approval takes **10–25 s** on Sepolia (relayer tx + judge tx). Keep talking, trim later.
- To get a penalty, approve code that is **visibly wrong** (see §6). To earn a point, approve only the correct one.

---

## 3. What the screen shows

```
┌ header: title · "World ID: simulated" badge · judge address ─────────────────────────┐
│ 1. Sign in            │ 2. AI answer                          │ Your standing          │
│ Connect MetaMask      │ [Ask the AI: write a hello world fn]  │ Active / Restricted /  │
│ Enroll with World ID  │ code card · round n                   │ Banned · countdown     │
│ Enrolled ✓ SIMULATED  │ [✓ Approve] [✗ Reject]                │ Penalty tokens x/3     │
│                       │ judge box: verdict, fingerprint ✓     │ Judge: lift restriction│
│                       │                                       │ ★ Reward points x/5    │
├───────────────────────┴───────────────────────────────────────┴────────────────────────┤
│ Receipts: #n · time · tx link · judge result (Good decision ✓ / Wrong → token)          │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Clips to record (in this order)

| Clip | Account | Click path | What must be visible | Say |
|---|---|---|---|---|
| **01-enroll** | A | Connect MetaMask → Enroll with World ID → confirm in MetaMask | "Enrolled ✓ · credential: SIMULATED", yellow badge | "One human, one account. World ID is simulated today: our only World ID has no 4.0 credential. The contract marks it as SIMULATED, never Orb." |
| **02-reject** | A | Ask the AI → **✗ Reject** | round 1 → round 2, no MetaMask popup | "Reject just asks again. Nothing goes on-chain, nobody is punished." |
| **03-approve** | A | on the **correct** answer → **✓ Approve** → sign | receipt #n in Receipts with Etherscan link | "Approve is a signature from my wallet. The relayer pays gas. A receipt, no token." |
| **04-good** | A | (right after 03) | judge box: **Fingerprint matches ✓**, **Good decision ✓**, **★ +1 reward point** | "The verdict was sealed in the receipt before I clicked: hash(code, verdict, salt). The judge reveals it now; anyone can check." |
| **05-points** | A | repeat Ask → (reject until correct) → Approve, wait for "next point" countdown between | ★ 5 / 5 → **Opt in to the prize** → MetaMask | "Points are soulbound and slow: one per cooldown, the challenge difficulty. At five you enter the prize." |
| **06-slash** (optional) | A | approve a **wrong** answer | token #1, "All reward points slashed", **in the prize ✓** stays | "A mistake costs all points, but not the prize seat already earned." |
| **07-token1** | B | Enroll → approve a **wrong** answer | token 1/3, **Restricted 4:57** countdown, Ask/Approve grey | "Approving wrong code mints a soulbound penalty token. Restricted for five minutes." |
| **08-lift** | B | type a reason → **Lift restriction** | status Active, token stays "restriction lifted" | "The judge can lift the restriction early, with a reason. The token stays: it's the record." |
| **09-token2** | B | approve a wrong answer again | token 2/3, **Restricted ~9:57** | "Second strike: twice as long." |
| **10-ban** | B | lift → approve a wrong answer a third time | **Banned**, "⛔ Repo access closed", "a ban can't be lifted" | "Third strike: banned on-chain, forever. Not even the judge can undo it." |
| **11-claim** | A | **after 21:00 Madrid**: Claim 0.02 ETH → MetaMask | "Prize share claimed ✓" | "After the deadline, qualified validators split the pool equally." |
| **12-etherscan** | – | click a receipt tx and a penalty token link | the tx on Sepolia; token on the PenaltyLedger | "Everything you saw is on Sepolia." |

If a clip goes wrong: account A or B is not burned unless it reached 3 tokens; just retake.
If B gets banned too early: enroll a third MetaMask account (needs ~0.003 Sepolia ETH).

---

## 5. Two-minute video script

| Time | Clip | Voice-over |
|---|---|---|
| 0:00–0:12 | title / page | "AI writes code. A human approves. When the approval is wrong, who answers for it? We make approvals accountable." |
| 0:12–0:25 | 01-enroll | "Each validator is one human, via World ID (simulated in this demo), enrolled on Sepolia." |
| 0:25–0:35 | 02-reject | "The AI proposes. Reject asks again: no cost." |
| 0:35–0:55 | 03 + 04 | "Approve signs a receipt on-chain. The verdict was sealed before the click; the judge reveals it: good decision, plus one reward point." |
| 0:55–1:10 | 05 | "Points are soulbound and earned slowly. Five points enter the prize pool." |
| 1:10–1:35 | 07 + 08 + 09 | "Approve wrong code: a soulbound penalty token and a restriction. The judge can lift it early; the token stays. Second strike lasts longer." |
| 1:35–1:50 | 10 | "Third strike: banned forever, enforced by the contract." |
| 1:50–2:00 | 12 / outro | "Receipts, penalties and rewards: all on Sepolia. Human-in-the-loop, with skin in the game." |

---

## 6. Recognising right vs wrong answers

The only correct answer:
```js
function helloWorld() {
  return "Hello, World!";
}
```
Wrong ones (approve these to get a penalty): `"Helo, World!"` (typo) · no `return` (a `const greeting`) ·
`function helloWord` (name) · `// TODO: greet` (returns nothing) · a missing closing `}` (syntax error).

---

## 7. Live Q&A: honest answers

| Question | Answer |
|---|---|
| Is World ID real here? | The integration is built and runs against World's real verify API, but our only World ID returns `credential_unavailable` (no World ID 4.0 credential), and sessions only exist in 4.0. So the demo runs `WORLD_ID_MODE=simulated`: visible badge, level SIMULATED on-chain, never Orb. |
| Who is the judge? | A server key (the relayer): it knows the right answer because it generated it. It mints penalties, awards/slashes points, lifts restrictions. A demo trust assumption, documented in `docs/LIMITS.md` and `AUDIT.md` (C-10, C-12, C-13). |
| Could the judge cheat? | It can't change the verdict after the fact: `contextHash = hash(code, verdict, salt)` is recorded in the receipt before the user decides; the page recomputes it ("fingerprint matches ✓"). It can't lift a ban or delete a token. |
| Why soulbound? | Reputation that can be sold or transferred isn't reputation. Neither penalty tokens nor points have any transfer function. |
| Why is the AI fake? | Scope: the point is the accountability layer. The "AI" serves one correct and five subtly wrong hello-worlds from files; a secure coin picks 50/50. |
| Is it audited? | An AI-assisted review (`AUDIT.md`) with 110 Foundry tests and 151 app tests; not a professional audit. |
| What's next? | Real World ID 4.0 sessions, a real agent, a GitHub merge gate, several humans with appeals. |

---

## 8. Addresses (Sepolia)

| Contract | Address |
|---|---|
| HumanRegistry | [0x35d619cFb1a86DC537d42EE495c36f0c46Af4d30](https://sepolia.etherscan.io/address/0x35d619cFb1a86DC537d42EE495c36f0c46Af4d30) |
| PermissionRegistry | [0x32E48C4492457152DaB31bD2b37A83223C1a0eC0](https://sepolia.etherscan.io/address/0x32E48C4492457152DaB31bD2b37A83223C1a0eC0) |
| ValidationReceipts | [0xF292d62DEa44171D883e2873d3D0688e6CBbD8De](https://sepolia.etherscan.io/address/0xF292d62DEa44171D883e2873d3D0688e6CBbD8De) |
| PenaltyLedger (penalty tokens) | [0xA4730F419bea45Cd9afA538CAf36e23ec45AD679](https://sepolia.etherscan.io/address/0xA4730F419bea45Cd9afA538CAf36e23ec45AD679) |
| ChallengeRewards (points + prize) | [0x9d918d9f1Aa9Ae0a88679858718D0191973EC270](https://sepolia.etherscan.io/address/0x9d918d9f1Aa9Ae0a88679858718D0191973EC270) |
| Judge / relayer | [0x99fa6dc0ea8eE05816EF79b0380a7AfA68088328](https://sepolia.etherscan.io/address/0x99fa6dc0ea8eE05816EF79b0380a7AfA68088328) |

---

## 9. Timeline (Madrid)

| Time | What |
|---|---|
| now → 19:00 | fixes and additions (see §10), then feature freeze |
| 19:00–21:00 | record clips 01–10 and 12 |
| 21:00 | deadline passes → record 11-claim |
| 21:30 | README, docs, security pass done |
| 22:00–23:00 | edit the 2-minute video |
| **23:30** | **submit on ETHGlobal** (repo link, video link, 3-sentence description from §1) |

---

## 10. Open items before recording (update as we go)

- [ ] **Judge password on "Lift restriction"**: today anyone who opens the page can make the judge key lift a
      restriction. Fix: server-only `JUDGE_PASSWORD`, asked in the lift box.
- [ ] Repo public on GitHub (required for submission).
- [ ] README with the 60-second demo and addresses (Step 7).
