# Presentation guide: follow along

For whoever records the video and presents live. Everything runs on **Sepolia** from
**http://localhost:3000/demo**. Keep this file open on a second screen.

---

## 1. The pitch in 3 sentences

1. AI writes code and a human clicks "approve": when that approval is wrong, nobody is accountable.
2. Every review is signed by one verified human (World ID) and recorded on-chain; each review earns a soulbound
   **reward token**, but approving code that fails lets the judge **slash every token**.
3. A **bounty** pays its prize only to reviewers who earned 5 tokens, and tokens come slowly (one per cooldown,
   shared across bounties), so the system pays for careful review, not fast clicking.

---

## 2. Before you start (10 minutes)

| # | Check | How |
|---|---|---|
| 1 | Dev server running | `cd app && npm run dev` → http://localhost:3000/demo shows the yellow **World ID: simulated** badge |
| 2 | MetaMask on **Sepolia** | account **A = `0x5956…e83b`** (main demo); **B = `0x86f7…e83b`** as a spare |
| 3 | Gas | your account ≥ 0.003 Sepolia ETH; relayer `0x99fa…8328` ≥ 0.01 (ask Claude: "check balance") |
| 4 | Browser | zoom **125 %**, close other tabs, hide bookmarks bar |
| 5 | Recorder | **Win + Alt + R** start/stop; files in `Videos\Captures`; rename right away; < 30 s each |
| 6 | Etherscan tab | https://sepolia.etherscan.io open |

**Rules while recording**
- A token needs **30 s since your last one** (shared cooldown). Watch "Next token in 0:xx" before the next review.
- Every approval takes **10–25 s** on Sepolia (receipt + judge transactions). Keep talking, trim later.
- The prize is **0.01 ETH** and can be claimed **once**: record the claim clip only when everything else is done.

---

## 3. What the screen shows

```
┌ header: title · "World ID: simulated" badge · judge address ──────────────────────────┐
│ 1. Sign in            │ 2. AI answer                           │ Your standing         │
│ Connect MetaMask      │ [Spawn code sample]                    │ ★ n / 5 reward tokens │
│ Enroll with World ID  │ code card · round n                    │ Next token in 0:xx    │
│ Enrolled ✓ SIMULATED  │ [✓ Approve] [✗ Report] [⏭ Skip]        │ Bounty · code link ↗  │
│                       │ judge box: verdict, fingerprint ✓,     │ Prize pool · qualified│
│                       │ +1 token / tokens slashed              │ [Qualify] / [Claim]   │
├───────────────────────┴────────────────────────────────────────┴───────────────────────┤
│ Receipts: #n · time · tx link · judge result (Good decision ✓ / Code failed: slashed)   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. The rules on screen

| Code | You press | Result |
|---|---|---|
| works | ✓ Approve | +1 token, "Good decision ✓" |
| works | ✗ Report | +1 token (reporting is never punished) |
| fails | ✗ Report | +1 token |
| fails | ✓ Approve | +1 token, then the judge **slashes all your tokens** |
| any | ⏭ Skip | nothing |

A token only arrives if 30 s passed since your last one. At **5 tokens** press **Qualify**; after that a slash can't
take your prize seat. **Claim** pays your equal share of the pool.

---

## 5. Clips to record (in this order, account A)

| Clip | Click path | What must be visible | Say |
|---|---|---|---|
| **01-enroll** | Connect MetaMask → Enroll with World ID → confirm | "Enrolled ✓ · credential: SIMULATED", yellow badge | "One human, one account. World ID runs in simulated mode here; the contract records it as SIMULATED, never Orb." |
| **02-skip** | Spawn code sample → **⏭ Skip** | a new sample, nothing signed | "Skip costs nothing and earns nothing." |
| **03-report** | on a **failing** sample (no `
`) → **✗ Report** → sign | round 2, "Reported. +1 reward token", 1/5 | "Reporting is a signed review: one token." |
| **04-approve** | wait 30 s → on the **correct** sample (with `
`) → **✓ Approve** → sign | receipt with Etherscan link; judge box: **Fingerprint matches ✓**, **Good decision ✓**, **+1 reward token** | "The verdict was sealed in the receipt before I clicked: hash(code, verdict, salt). The judge reveals it; anyone can check." |
| **05-slash** | wait 30 s → on a **failing** sample → **✓ Approve** | "You approved code that fails. Wrong approval: all reward tokens slashed", 0/5 | "Approving broken code costs everything earned so far." |
| **06-five** | earn 5 tokens again (reviews 30 s apart, never approve failing code) → **Qualify for the prize** | 5/5, "you qualified ✓", 1 qualified | "Five careful reviews, earned slowly, qualify me for the bounty." |
| **07-claim** | **Claim 0.01 ETH** → confirm | "Prize share claimed ✓", balance up in MetaMask | "Qualified reviewers split the prize." |
| **08-etherscan** | click the receipt tx, the Bounty and the RewardToken links | the transactions on Sepolia | "Everything you saw is on Sepolia." |

---

## 6. Two-minute video script

| Time | Clip | Voice-over |
|---|---|---|
| 0:00–0:12 | page | "AI writes code. A human approves. When the approval is wrong, who answers for it?" |
| 0:12–0:24 | 01 | "Each reviewer is one human, via World ID, enrolled on Sepolia." |
| 0:24–0:40 | 02 + 03 | "The AI proposes code. Skip is free. Report is a signed review and earns a soulbound token." |
| 0:40–1:00 | 04 | "Approve records a receipt on-chain. The verdict was sealed before the click; the judge reveals it: good decision, another token." |
| 1:00–1:15 | 05 | "Approve code that fails, and the judge slashes every token." |
| 1:15–1:40 | 06 + 07 | "Tokens come slowly: one per thirty seconds, shared across bounties. Five qualify for the bounty; qualified reviewers split the prize." |
| 1:40–2:00 | 08 | "Receipts, tokens, slashes and the prize: all on Sepolia. Human review, with skin in the game." |

---

## 7. Recognising right vs wrong samples

**Look at the `printf` line: only the correct program prints `
`.**

```c
#include <stdio.h>

int main(void)
{
    printf("Hello world!
");
    return 0;
}
```
Every failing sample prints `"Hello world!"` **without** `
` and has one silly mistake: a missing `;` after
`printf(...)`, `return exit;`, `print(...)` instead of `printf(...)`, or `return "0";`.

---

## 8. Live Q&A: honest answers

| Question | Answer |
|---|---|
| Is World ID real here? | The integration is built, and a real World ID proof passed on our server's test page. The demo runs `WORLD_ID_MODE=simulated` for recording: visible badge, level SIMULATED on-chain, never Orb. |
| Who is the judge? | A server key (the relayer): it knows the right answer because it generated the sample. It awards and slashes tokens. A demo trust assumption, documented in `docs/LIMITS.md` and `AUDIT.md` (C-10, C-13). |
| Could the judge cheat on the verdict? | No: `contextHash = hash(code, verdict, salt)` is recorded in the receipt before you decide; the page recomputes it ("fingerprint matches ✓"). |
| Why can't I farm tokens? | One token per sample, and one per 30 s per human, shared across all bounties (the cooldown lives in the token). |
| Why soulbound? | Reputation that can be sold isn't reputation: the token contract has no transfer function. |
| What about the penalty NFT / bans? | Built and tested (`PenaltyLedger`: restrictions, ban at 3), not used in this demo: mistakes only slash tokens. |
| Is it audited? | AI-assisted review (`AUDIT.md`), 110 Foundry tests and 151 app tests; not a professional audit. |

---

## 9. Addresses (Sepolia)

| Contract | Address |
|---|---|
| Bounty (code link + prize) | [0x882C6095C009EE63EB725B28C590034ae19F75A3](https://sepolia.etherscan.io/address/0x882C6095C009EE63EB725B28C590034ae19F75A3) |
| RewardToken (soulbound, cooldown, slash) | [0xD5CDd7f50fb022ea0403ECbeC8F2C7F1a4cFBeae](https://sepolia.etherscan.io/address/0xD5CDd7f50fb022ea0403ECbeC8F2C7F1a4cFBeae) |
| HumanRegistry | [0x35d619cFb1a86DC537d42EE495c36f0c46Af4d30](https://sepolia.etherscan.io/address/0x35d619cFb1a86DC537d42EE495c36f0c46Af4d30) |
| ValidationReceipts | [0xF292d62DEa44171D883e2873d3D0688e6CBbD8De](https://sepolia.etherscan.io/address/0xF292d62DEa44171D883e2873d3D0688e6CBbD8De) |
| PermissionRegistry | [0x32E48C4492457152DaB31bD2b37A83223C1a0eC0](https://sepolia.etherscan.io/address/0x32E48C4492457152DaB31bD2b37A83223C1a0eC0) |
| PenaltyLedger (not used in the demo) | [0xA4730F419bea45Cd9afA538CAf36e23ec45AD679](https://sepolia.etherscan.io/address/0xA4730F419bea45Cd9afA538CAf36e23ec45AD679) |
| Judge / relayer | [0x99fa6dc0ea8eE05816EF79b0380a7AfA68088328](https://sepolia.etherscan.io/address/0x99fa6dc0ea8eE05816EF79b0380a7AfA68088328) |

---

## 10. Timeline (Madrid, Windows clock)

| Time | What |
|---|---|
| now → 21:30 | record clips 01–08 |
| 21:30 | README + final docs |
| 22:00–23:00 | edit the 2-minute video |
| **23:30** | **submit on ETHGlobal** (repo link, video link, 3 sentences from §1) |

## 11. Open items

- [ ] Repo public on GitHub (required for submission).
- [ ] README with the 60-second demo and addresses.
