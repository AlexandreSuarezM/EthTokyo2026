import { hashTypedData, recoverTypedDataAddress, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { humanRegistryAbi } from "@/lib/chain/abi";
import { ENROLL_TYPES, createAttester, registryDomain, sessionRefOf } from "@/lib/chain/attester";
import { sqliteDriver } from "@/lib/db/drivers";
import { createStore, type Store } from "@/lib/db/store";
import { handleEnroll } from "@/lib/enroll/handler";
import {
  ATTESTATION_TTL_SECONDS,
  PENDING_TTL_SECONDS,
  completeEnrollment,
  startEnrollment,
  type EnrollDeps,
} from "@/lib/enroll/service";
import { WorldError } from "@/lib/world/errors";
import { humanIdFromNullifier } from "@/lib/world/identity";
import { hasChain, startChain, type TestChain } from "@/test/anvil";
import { mockFetch, newSessionId, rand32, sessionResult, uniquenessResult, worldAccepts } from "@/test/world";

const attesterAccount = privateKeyToAccount(generatePrivateKey());
const account = privateKeyToAccount(generatePrivateKey()).address;
const NOW = 1_800_000_000;

type Harness = {
  deps: EnrollDeps;
  store: Store;
  world: ReturnType<typeof mockFetch>;
  onChain: { accounts: Map<Hex, Address>; humans: Map<Address, Hex> };
  clock: { now: number };
};

async function harness(world = worldAccepts()): Promise<Harness> {
  const store = await createStore(await sqliteDriver("file::memory:"));
  const onChain = { accounts: new Map<Hex, Address>(), humans: new Map<Address, Hex>() };
  const clock = { now: NOW };
  const chain = { chainId: 11155111, humanRegistry: "0x00000000000000000000000000000000000000A1" as Address };
  let n = 0;
  const deps: EnrollDeps = {
    store,
    verify: { rpId: "rp_test", environment: "production", fetch: world.fetch },
    registry: {
      accountOf: async (h) => onChain.accounts.get(h) ?? zeroAddress,
      humanOf: async (a) => onChain.humans.get(a) ?? zeroHash,
    },
    attester: createAttester(attesterAccount, { chainId: chain.chainId, humanRegistry: chain.humanRegistry, validationReceipts: zeroAddress }),
    chain,
    now: () => clock.now,
    randomId: () => (++n).toString(16).padStart(64, "0"),
  };
  return { deps, store, world, onChain, clock };
}

async function codeOf(p: Promise<unknown>) {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(WorldError);
  return (e as WorldError).code;
}

async function startPending(h: Harness, opts: Parameters<typeof uniquenessResult>[0] = { account }) {
  const res = await startEnrollment(h.deps, { account: opts.account, result: uniquenessResult(opts) });
  if (res.status !== "pending") throw new Error("expected pending");
  return res;
}

describe("enrollment", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.store.close());

  it("happy path (Proof of Human): start, complete, attestation signed for the wallet", async () => {
    const nullifier = rand32();
    const pending = await startPending(h, { account, nullifier });
    expect(pending).toMatchObject({ humanId: humanIdFromNullifier(nullifier), credentialLevel: 1, expiresAt: NOW + PENDING_TTL_SECONDS });

    const sessionId = newSessionId();
    const { attestation: a } = await completeEnrollment(h.deps, {
      enrollmentId: pending.enrollmentId,
      result: sessionResult({ enrollmentId: pending.enrollmentId, sessionId }),
    });
    expect(a).toMatchObject({
      account,
      humanId: pending.humanId,
      sessionRef: sessionRefOf(sessionId),
      credentialLevel: 1,
      deadline: String(NOW + ATTESTATION_TTL_SECONDS),
      chainId: 11155111,
    });
    const message = {
      account: a.account,
      humanId: a.humanId,
      sessionRef: a.sessionRef,
      credentialLevel: a.credentialLevel,
      deadline: BigInt(a.deadline),
    };
    const domain = registryDomain({ chainId: a.chainId, humanRegistry: a.humanRegistry, validationReceipts: zeroAddress });
    expect(
      await recoverTypedDataAddress({ domain, types: ENROLL_TYPES, primaryType: "AttestedEnroll", message, signature: a.signature }),
    ).toBe(attesterAccount.address);

    // the account id is the session_id; the pending enrollment is gone
    expect(await h.store.sessionOfHuman(pending.humanId)).toMatchObject({ sessionId, credentialLevel: 1, sybilScore: null });
    expect(await h.store.getPending(pending.enrollmentId)).toBeNull();
    expect(h.world.calls).toHaveLength(2);
  });

  it("Selfie Check: level 2 and the sybil score are stored", async () => {
    const pending = await startPending(h, { account, schema: 11, sybil: 1.25 });
    expect(pending.credentialLevel).toBe(2);
    const { attestation } = await completeEnrollment(h.deps, {
      enrollmentId: pending.enrollmentId,
      result: sessionResult({ enrollmentId: pending.enrollmentId, schema: 11, sybil: 1.3 }),
    });
    expect(attestation.credentialLevel).toBe(2);
    expect((await h.store.sessionOfHuman(pending.humanId))?.sybilScore).toBe(1.25);
  });

  describe("start fails closed", () => {
    it("refuses a proof made for another wallet, without calling World", async () => {
      const other = privateKeyToAccount(generatePrivateKey()).address;
      const code = await codeOf(startEnrollment(h.deps, { account, result: uniquenessResult({ account: other }) }));
      expect(code).toBe("rejected");
      expect(h.world.calls).toHaveLength(0);
    });

    it("refuses malformed bodies", async () => {
      expect(await codeOf(startEnrollment(h.deps, { account: "0x123", result: {} }))).toBe("invalid_request");
      expect(await codeOf(startEnrollment(h.deps, { account, result: uniquenessResult({ account }), extra: 1 }))).toBe(
        "invalid_request",
      );
      expect(await codeOf(startEnrollment(h.deps, { account, result: { protocol_version: "3.0" } }))).toBe("unavailable_credential");
    });

    it("refuses a human or a wallet already enrolled on-chain", async () => {
      const nullifier = rand32();
      h.onChain.accounts.set(humanIdFromNullifier(nullifier), privateKeyToAccount(generatePrivateKey()).address);
      expect(await codeOf(startEnrollment(h.deps, { account, result: uniquenessResult({ account, nullifier }) }))).toBe(
        "already_enrolled",
      );
      h.onChain.humans.set(account, rand32());
      expect(await codeOf(startEnrollment(h.deps, { account, result: uniquenessResult({ account }) }))).toBe("already_enrolled");
    });

    it("returns World's typed error and stores nothing", async () => {
      const failing = await harness(mockFetch({ status: 400, body: { code: "all_verifications_failed", results: [{ code: "user_rejected" }] } }));
      expect(await codeOf(startEnrollment(failing.deps, { account, result: uniquenessResult({ account }) }))).toBe("cancelled");
      expect(await failing.store.getPending("1".padStart(64, "0"))).toBeNull();
      await failing.store.close();
    });

    it("maps a chain read failure to a typed error", async () => {
      h.deps.registry.accountOf = async () => {
        throw new Error("rpc down");
      };
      expect(await codeOf(startEnrollment(h.deps, { account, result: uniquenessResult({ account }) }))).toBe(
        "verification_unavailable",
      );
    });
  });

  describe("resume", () => {
    it("re-issues the attestation when the wallet never sent the transaction", async () => {
      const nullifier = rand32();
      const pending = await startPending(h, { account, nullifier });
      const sessionId = newSessionId();
      await completeEnrollment(h.deps, { enrollmentId: pending.enrollmentId, result: sessionResult({ enrollmentId: pending.enrollmentId, sessionId }) });

      h.clock.now += 3600; // the first attestation expired
      const again = await startEnrollment(h.deps, { account, result: uniquenessResult({ account, nullifier }) });
      expect(again.status).toBe("attested");
      if (again.status === "attested") {
        expect(again.attestation.sessionRef).toBe(sessionRefOf(sessionId));
        expect(again.attestation.deadline).toBe(String(h.clock.now + ATTESTATION_TTL_SECONDS));
      }
    });

    it("refuses to resume with a different wallet", async () => {
      const nullifier = rand32();
      const pending = await startPending(h, { account, nullifier });
      await completeEnrollment(h.deps, { enrollmentId: pending.enrollmentId, result: sessionResult({ enrollmentId: pending.enrollmentId }) });
      const other = privateKeyToAccount(generatePrivateKey()).address;
      expect(await codeOf(startEnrollment(h.deps, { account: other, result: uniquenessResult({ account: other, nullifier }) }))).toBe(
        "already_enrolled",
      );
    });
  });

  describe("complete fails closed", () => {
    it("refuses an unknown or expired enrollment", async () => {
      const unknown = "f".repeat(64);
      expect(await codeOf(completeEnrollment(h.deps, { enrollmentId: unknown, result: sessionResult({ enrollmentId: unknown }) }))).toBe(
        "expired",
      );
      const pending = await startPending(h);
      h.clock.now += PENDING_TTL_SECONDS + 1;
      expect(
        await codeOf(completeEnrollment(h.deps, { enrollmentId: pending.enrollmentId, result: sessionResult({ enrollmentId: pending.enrollmentId }) })),
      ).toBe("expired");
    });

    it("refuses a session proof made for another enrollment", async () => {
      const pending = await startPending(h);
      const result = sessionResult({ enrollmentId: pending.enrollmentId, signal: "hitl-session:someone-else" });
      expect(await codeOf(completeEnrollment(h.deps, { enrollmentId: pending.enrollmentId, result }))).toBe("rejected");
    });

    it("refuses a session with a different credential than the enrollment proof", async () => {
      const pending = await startPending(h); // Proof of Human
      const result = sessionResult({ enrollmentId: pending.enrollmentId, schema: 11, sybil: 1 });
      expect(await codeOf(completeEnrollment(h.deps, { enrollmentId: pending.enrollmentId, result }))).toBe("rejected");
      expect(await h.store.sessionOfHuman(pending.humanId)).toBeNull();
    });

    it("is single use: a replayed complete gets nothing", async () => {
      const pending = await startPending(h);
      const body = { enrollmentId: pending.enrollmentId, result: sessionResult({ enrollmentId: pending.enrollmentId }) };
      await completeEnrollment(h.deps, body);
      expect(await codeOf(completeEnrollment(h.deps, body))).toBe("expired");
    });

    it("refuses a session_id already bound to another human", async () => {
      const sessionId = newSessionId();
      const first = await startPending(h);
      await completeEnrollment(h.deps, { enrollmentId: first.enrollmentId, result: sessionResult({ enrollmentId: first.enrollmentId, sessionId }) });

      const otherWallet = privateKeyToAccount(generatePrivateKey()).address;
      const second = await startPending(h, { account: otherWallet });
      const code = await codeOf(
        completeEnrollment(h.deps, { enrollmentId: second.enrollmentId, result: sessionResult({ enrollmentId: second.enrollmentId, sessionId }) }),
      );
      expect(code).toBe("rejected");
      expect(await h.store.sessionOfHuman(second.humanId)).toBeNull();
    });

    it("refuses a replayed session nullifier", async () => {
      const sessionNullifier = rand32();
      const first = await startPending(h);
      await completeEnrollment(h.deps, {
        enrollmentId: first.enrollmentId,
        result: sessionResult({ enrollmentId: first.enrollmentId, sessionNullifier }),
      });
      const second = await startPending(h, { account: privateKeyToAccount(generatePrivateKey()).address });
      const code = await codeOf(
        completeEnrollment(h.deps, {
          enrollmentId: second.enrollmentId,
          result: sessionResult({ enrollmentId: second.enrollmentId, sessionNullifier }),
        }),
      );
      expect(code).toBe("rejected");
    });

    it("keeps the enrollment retryable when World fails, and stores no session", async () => {
      const pending = await startPending(h);
      const down = mockFetch({ status: 503, body: {} });
      const deps = { ...h.deps, verify: { ...h.deps.verify, fetch: down.fetch } };
      const body = { enrollmentId: pending.enrollmentId, result: sessionResult({ enrollmentId: pending.enrollmentId }) };
      expect(await codeOf(completeEnrollment(deps, body))).toBe("verification_unavailable");
      expect(await h.store.sessionOfHuman(pending.humanId)).toBeNull();
      expect((await completeEnrollment(h.deps, body)).status).toBe("attested"); // retry works
    });

    it("refuses when the wallet got enrolled in the meantime", async () => {
      const pending = await startPending(h);
      h.onChain.humans.set(account, rand32());
      const body = { enrollmentId: pending.enrollmentId, result: sessionResult({ enrollmentId: pending.enrollmentId }) };
      expect(await codeOf(completeEnrollment(h.deps, body))).toBe("already_enrolled");
      expect(await h.store.sessionOfHuman(pending.humanId)).toBeNull();
    });
  });
});

describe("route handler", () => {
  it("maps typed errors to HTTP and hides unexpected ones", async () => {
    const h = await harness();
    const req = (body: string) => new Request("http://localhost/api/enroll/start", { method: "POST", body });

    const bad = await handleEnroll(req("{nope"), async () => h.deps, startEnrollment);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_request" });

    const other = privateKeyToAccount(generatePrivateKey()).address;
    const wrongWallet = await handleEnroll(req(JSON.stringify({ account, result: uniquenessResult({ account: other }) })), async () => h.deps, startEnrollment);
    expect(wrongWallet.status).toBe(422);
    expect(await wrongWallet.json()).toMatchObject({ error: "rejected" });

    const boom = await handleEnroll(req("{}"), async () => h.deps, async () => {
      throw new Error("secret detail: key=abc");
    });
    expect(boom.status).toBe(503);
    expect(JSON.stringify(await boom.json())).not.toContain("secret");

    const ok = await handleEnroll(req(JSON.stringify({ account, result: uniquenessResult({ account }) })), async () => h.deps, startEnrollment);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    await h.store.close();
  });
});

describe.skipIf(!hasChain)("enrollment end to end (anvil)", () => {
  let chain: TestChain;
  beforeAll(async () => {
    chain = await startChain(attesterAccount.address);
  }, 30_000);
  afterAll(() => chain?.stop());

  it("the wallet enrolls itself with the attestation; a copied attestation fails for another wallet", async () => {
    const store = await createStore(await sqliteDriver("file::memory:"));
    const { client, domains } = chain;
    const now = Number((await client.getBlock()).timestamp);
    const deps: EnrollDeps = {
      store,
      verify: { rpId: "rp_test", environment: "production", fetch: worldAccepts().fetch },
      registry: {
        accountOf: (humanId) => client.readContract({ address: domains.humanRegistry, abi: humanRegistryAbi, functionName: "accountOf", args: [humanId] }),
        humanOf: (a) => client.readContract({ address: domains.humanRegistry, abi: humanRegistryAbi, functionName: "humanOf", args: [a] }),
      },
      attester: createAttester(attesterAccount, domains),
      chain: { chainId: domains.chainId, humanRegistry: domains.humanRegistry },
      now: () => now,
    };

    const wallet = await chain.newWallet();
    const attacker = await chain.newWallet();
    const me = wallet.account.address;
    const start = await startEnrollment(deps, { account: me, result: uniquenessResult({ account: me }) });
    if (start.status !== "pending") throw new Error("expected pending");
    const { attestation: a } = await completeEnrollment(deps, {
      enrollmentId: start.enrollmentId,
      result: sessionResult({ enrollmentId: start.enrollmentId }),
    });
    const args = [a.humanId, a.sessionRef, a.credentialLevel, BigInt(a.deadline), a.signature] as const;

    // Same digest as the contract computes.
    expect(
      hashTypedData({
        domain: registryDomain(domains),
        types: ENROLL_TYPES,
        primaryType: "AttestedEnroll",
        message: { account: me, humanId: a.humanId, sessionRef: a.sessionRef, credentialLevel: a.credentialLevel, deadline: BigInt(a.deadline) },
      }),
    ).toBe(
      await client.readContract({
        address: domains.humanRegistry,
        abi: humanRegistryAbi,
        functionName: "enrollDigest",
        args: [me, ...args.slice(0, 4)] as never,
      }),
    );

    // Another wallet can't use it (the signature binds msg.sender).
    await expect(
      client.simulateContract({ account: attacker.account, address: domains.humanRegistry, abi: humanRegistryAbi, functionName: "enrollAttested", args }),
    ).rejects.toThrow(/BadAttestation/);

    const hash = await wallet.writeContract({ address: domains.humanRegistry, abi: humanRegistryAbi, functionName: "enrollAttested", args });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");
    expect(await deps.registry.humanOf(me)).toBe(a.humanId);

    // Enrolling again now fails closed on the chain check.
    const again = await startEnrollment(deps, { account: me, result: uniquenessResult({ account: me }) }).catch((e: unknown) => e);
    expect(again).toMatchObject({ code: "already_enrolled" });
    await store.close();
  });
});
