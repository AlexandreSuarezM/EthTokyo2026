import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zeroHash, type Address, type Hash, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_TYPES, createAttester, type Domains } from "@/lib/chain/attester";
import type { ValidateArgs } from "@/lib/chain/relayer";
import { sqliteDriver } from "@/lib/db/drivers";
import { createStore, type Store } from "@/lib/db/store";
import { DEMO_REPO, commitmentOf, loadVariants, withDemoRepo, type Coin } from "@/lib/demo/ai";
import { ask, judge, lift, onboard, prepare, reject, standing, type ChainReads, type DemoDeps } from "@/lib/demo/service";
import { noRepoSource } from "@/lib/repo/source";
import { completeApproval } from "@/lib/world/approve";
import { WorldError } from "@/lib/world/errors";

const chain: Domains = {
  chainId: 11155111,
  humanRegistry: "0x00000000000000000000000000000000000000a1",
  validationReceipts: "0x00000000000000000000000000000000000000b2",
};

async function codeOf(p: Promise<unknown>) {
  const e = await p.then(() => undefined, (err: unknown) => err);
  expect(e).toBeInstanceOf(WorldError);
  return (e as WorldError).code;
}

/** A coin whose flips the test scripts: true = correct answer. */
function scriptedCoin(flips: boolean[]): Coin {
  let n = 0;
  return {
    flip: () => flips[n++ % flips.length],
    pick: () => 0,
    salt: () => `0x${String(n).padStart(64, "0")}` as Hex,
    id: () => `${String(++n).padStart(8, "0")}`.padEnd(64, "a"),
  };
}

type World = {
  deps: DemoDeps;
  store: Store;
  user: ReturnType<typeof privateKeyToAccount>;
  human: Hex;
  chainState: { stage: number; banned: boolean; enrolled: boolean; validator: boolean; contexts: Map<bigint, Hex> };
  calls: { penalize: [bigint, Hex][]; lift: [Hex, Hex][]; grant: Hex[] };
};

async function world(flips: boolean[] = [true]): Promise<World> {
  const store = await createStore(await sqliteDriver("file::memory:"));
  const user = privateKeyToAccount(generatePrivateKey());
  const human = `0x${"ab".repeat(32)}` as Hex;
  await store.saveSession({ humanId: human, sessionId: `session_${"c".repeat(128)}`, account: user.address, credentialLevel: 3, enrollNullifier: "1", sybilScore: null });
  const chainState = { stage: 0, banned: false, enrolled: true, validator: false, contexts: new Map<bigint, Hex>() };
  const calls: World["calls"] = { penalize: [], lift: [], grant: [] };
  let nextReceipt = 0n;
  const reads: ChainReads = {
    humanOf: async (a: Address) => (chainState.enrolled && a === user.address ? human : zeroHash),
    levelOf: async () => 3,
    stageOf: async () => (chainState.banned ? 3 : chainState.stage),
    scoreOf: async () => 0n,
    penaltyCount: async () => calls.penalize.length,
    isBannedForever: async () => chainState.banned,
    secondsRestricted: async () => (chainState.stage === 2 ? 297 : 0),
    hasValidatorPreset: async () => chainState.validator,
    receiptContextHash: async (id) => chainState.contexts.get(id) ?? zeroHash,
    penalties: async () => [],
    lifts: async () => [],
  };
  const deps: DemoDeps = {
    store,
    coin: scriptedCoin(flips),
    reads,
    writes: {
      penalize: async (id, ev) => {
        calls.penalize.push([id, ev]);
        return { tokenId: String(calls.penalize.length), txHash: `0x${"11".repeat(32)}` as Hash };
      },
      lift: async (h, r) => {
        calls.lift.push([h, r]);
        return `0x${"22".repeat(32)}` as Hash;
      },
      grant: undefined as never,
      grantValidator: async (h) => {
        calls.grant.push(h);
        chainState.validator = true;
        return `0x${"33".repeat(32)}` as Hash;
      },
    } as DemoDeps["writes"],
    approve: {
      store,
      repos: withDemoRepo(store, noRepoSource),
      verify: { rpId: "rp_test", environment: "production" },
      registry: { humanOf: reads.humanOf },
      attester: createAttester(privateKeyToAccount(generatePrivateKey()), chain),
      relayer: {
        submitValidate: async (args: ValidateArgs) => {
          nextReceipt += 1n;
          chainState.contexts.set(nextReceipt, args[0].contextHash); // what validate() records on-chain
          return { txHash: `0x${"ee".repeat(32)}` as Hash, receiptId: nextReceipt };
        },
      },
      chain,
      mode: "simulated",
    },
  };
  return { deps, store, user, human, chainState, calls };
}

async function approveAnswer(w: World, proposalId: string) {
  const p = await prepare(w.deps, { proposalId });
  const m = p.typedData.message;
  const signature = await w.user.signTypedData({
    domain: p.typedData.domain,
    types: APPROVAL_TYPES,
    primaryType: "HumanApproval",
    message: { ...m, nonce: BigInt(m.nonce), deadline: BigInt(m.deadline) },
  });
  return completeApproval(w.deps.approve, { approvalId: p.approvalId, signature });
}

describe("fake AI files", () => {
  it("has one correct answer and five subtly wrong ones", () => {
    const v = loadVariants();
    expect(v.correct.code).toContain('return "Hello, World!"');
    expect(v.wrong.map((x) => x.name).sort()).toEqual(["no-return.js", "prints-nothing.js", "syntax-error.js", "typo.js", "wrong-name.js"]);
    for (const x of v.wrong) expect(x.code).not.toBe(v.correct.code);
  });

  it("refuses a data dir without a correct answer", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hitl-ai-"));
    writeFileSync(path.join(dir, "typo.js"), "x");
    expect(() => loadVariants(dir)).toThrow();
  });
});

describe("demo flow", () => {
  let w: World;
  afterEach(() => w.store.close());

  describe("ask and reject", () => {
    beforeEach(async () => {
      w = await world([false, true]);
    });

    it("ask returns only the code: never the verdict, the variant or the salt", async () => {
      const a = await ask(w.deps, { account: w.user.address });
      expect(a.round).toBe(1);
      const json = JSON.stringify(a);
      for (const secret of ["wrong", "right", "typo.js", "correct.js", "verdict", "salt", "variant"]) expect(json).not.toContain(secret);
    });

    it("reject = a new answer in the next round, nothing on-chain", async () => {
      const a1 = await ask(w.deps, { account: w.user.address });
      const a2 = await reject(w.deps, { proposalId: a1.id });
      expect(a2.round).toBe(2);
      expect(a2.id).not.toBe(a1.id);
      const a3 = await reject(w.deps, { proposalId: a2.id });
      expect(a3.round).toBe(3);
      expect(w.calls.penalize).toHaveLength(0);
      expect(await codeOf(reject(w.deps, { proposalId: a1.id }))).toBe("stale"); // rejected once
    });

    it("refuses ask and approve when not enrolled, restricted or banned (fail closed)", async () => {
      const a = await ask(w.deps, { account: w.user.address });
      w.chainState.stage = 2;
      expect(await codeOf(ask(w.deps, { account: w.user.address }))).toBe("ineligible");
      expect(await codeOf(prepare(w.deps, { proposalId: a.id }))).toBe("ineligible");
      w.chainState.banned = true;
      expect(await codeOf(ask(w.deps, { account: w.user.address }))).toBe("ineligible");
      const stranger = privateKeyToAccount(generatePrivateKey()).address;
      expect(await codeOf(ask(w.deps, { account: stranger }))).toBe("not_enrolled");
    });
  });

  describe("approve and judge", () => {
    it("approved correct code: sealed fingerprint matches, Good decision, no token; judged once", async () => {
      w = await world([true]);
      const a = await ask(w.deps, { account: w.user.address });
      const r = await approveAnswer(w, a.id);
      const j = await judge(w.deps, { receiptId: r.receiptId });
      expect(j).toMatchObject({ verdict: "right", fingerprintMatches: true, tokenId: null, alreadyJudged: false });
      expect(w.chainState.contexts.get(BigInt(r.receiptId))).toBe(j.commitment); // contextHash on-chain = hash(code, verdict, salt)
      expect(j.commitment).toBe(commitmentOf(a.code, "right", j.salt));
      expect(w.calls.penalize).toHaveLength(0);
      expect((await judge(w.deps, { receiptId: r.receiptId })).alreadyJudged).toBe(true);
    });

    it("approved wrong code: the judge mints once, with the commitment as evidence", async () => {
      w = await world([false]);
      const a = await ask(w.deps, { account: w.user.address });
      const r = await approveAnswer(w, a.id);
      const j = await judge(w.deps, { receiptId: r.receiptId });
      expect(j).toMatchObject({ verdict: "wrong", fingerprintMatches: true, tokenId: "1" });
      expect(w.calls.penalize).toEqual([[BigInt(r.receiptId), j.commitment]]);
      const again = await judge(w.deps, { receiptId: r.receiptId });
      expect(again).toMatchObject({ alreadyJudged: true, tokenId: "1" });
      expect(w.calls.penalize).toHaveLength(1); // once per receipt

      const st = await standing(w.deps, w.user.address);
      expect(st.receipts[0]).toMatchObject({ receiptId: r.receiptId, judged: { verdict: "wrong", tokenId: "1" } });
    });

    it("refuses to judge when the on-chain fingerprint doesn't match", async () => {
      w = await world([false]);
      const a = await ask(w.deps, { account: w.user.address });
      const r = await approveAnswer(w, a.id);
      w.chainState.contexts.set(BigInt(r.receiptId), `0x${"99".repeat(32)}`);
      expect(await codeOf(judge(w.deps, { receiptId: r.receiptId }))).toBe("rejected");
      expect(w.calls.penalize).toHaveLength(0);
    });

    it("a failed mint releases the judgment so the judge can run again", async () => {
      w = await world([false]);
      const a = await ask(w.deps, { account: w.user.address });
      const r = await approveAnswer(w, a.id);
      const ok = w.deps.writes.penalize;
      w.deps.writes.penalize = async () => {
        throw new Error("rpc down");
      };
      expect(await codeOf(judge(w.deps, { receiptId: r.receiptId }))).toBe("verification_unavailable");
      w.deps.writes.penalize = ok;
      expect((await judge(w.deps, { receiptId: r.receiptId })).tokenId).toBe("1");
    });
  });

  describe("lift and onboard", () => {
    beforeEach(async () => {
      w = await world();
    });

    it("the judge lifts a restriction with a reason; never a ban; nothing to lift when active", async () => {
      expect(await codeOf(lift(w.deps, { account: w.user.address, reason: "first mistake, explained" }))).toBe("stale");
      w.chainState.stage = 2;
      await lift(w.deps, { account: w.user.address, reason: "first mistake, explained" });
      expect(w.calls.lift).toHaveLength(1);
      expect(await codeOf(lift(w.deps, { account: w.user.address, reason: "" }))).toBe("invalid_request");
      w.chainState.banned = true;
      expect(await codeOf(lift(w.deps, { account: w.user.address, reason: "please" }))).toBe("ineligible");
      expect(w.calls.lift).toHaveLength(1);
    });

    it("onboard grants the validator preset once, only to an enrolled wallet", async () => {
      expect(await onboard(w.deps, { account: w.user.address })).toMatchObject({ granted: true });
      expect(await onboard(w.deps, { account: w.user.address })).toMatchObject({ granted: false });
      expect(w.calls.grant).toEqual([w.human]);
      w.chainState.enrolled = false;
      expect(await codeOf(onboard(w.deps, { account: w.user.address }))).toBe("not_enrolled");
    });

    it("standing reports active / restricted with countdown / banned", async () => {
      expect(await standing(w.deps, w.user.address)).toMatchObject({ enrolled: true, status: "active", restrictedSeconds: 0 });
      w.chainState.stage = 2;
      expect(await standing(w.deps, w.user.address)).toMatchObject({ status: "restricted", restrictedSeconds: 297 });
      w.chainState.banned = true;
      expect(await standing(w.deps, w.user.address)).toMatchObject({ status: "banned", restrictedSeconds: 0 });
      expect((await standing(w.deps, privateKeyToAccount(generatePrivateKey()).address)).enrolled).toBe(false);
    });

    it("the demo repo is served only for demo/app", async () => {
      await expect(w.deps.approve.repos.inspect("other/repo", "a", "b")).rejects.toBeInstanceOf(WorldError);
      expect(DEMO_REPO).toBe("demo/app");
    });
  });
});
