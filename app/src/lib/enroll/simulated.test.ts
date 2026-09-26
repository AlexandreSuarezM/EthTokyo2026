import { zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as simulatedRoute } from "@/app/api/enroll/simulated/route";
import { humanRegistryAbi } from "@/lib/chain/abi";
import { createAttester } from "@/lib/chain/attester";
import { sqliteDriver } from "@/lib/db/drivers";
import { createStore } from "@/lib/db/store";
import { SIMULATED_LEVEL, simulatedEnrollment, simulatedHumanId, type EnrollDeps } from "@/lib/enroll/service";
import { handleJson } from "@/lib/http/handler";
import { WorldError } from "@/lib/world/errors";
import { humanIdFromNullifier } from "@/lib/world/identity";
import { hasChain, startChain, type TestChain } from "@/test/anvil";

const attesterAccount = privateKeyToAccount(generatePrivateKey());

async function deps(onChain = { accounts: new Map<Hex, Address>(), humans: new Map<Address, Hex>() }): Promise<EnrollDeps> {
  const store = await createStore(await sqliteDriver("file::memory:"));
  const chain = { chainId: 11155111, humanRegistry: "0x00000000000000000000000000000000000000a1" as Address };
  return {
    store,
    verify: { rpId: "rp_test", environment: "production", fetch: (() => {
      throw new Error("simulated mode must never call World");
    }) as unknown as typeof fetch },
    registry: {
      accountOf: async (h) => onChain.accounts.get(h) ?? zeroAddress,
      humanOf: async (a) => onChain.humans.get(a) ?? zeroHash,
    },
    attester: createAttester(attesterAccount, { ...chain, validationReceipts: zeroAddress }),
    chain,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("simulated enrollment (WORLD_ID_MODE=simulated)", () => {
  it("enrolls at the SIMULATED level without calling World, in its own humanId namespace", async () => {
    const d = await deps();
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const { attestation } = await simulatedEnrollment(d, { account });
    expect(attestation.credentialLevel).toBe(SIMULATED_LEVEL);
    expect(attestation.credentialLevel).not.toBe(1); // never Orb
    expect(attestation.humanId).toBe(simulatedHumanId(account));
    expect(attestation.humanId).not.toBe(humanIdFromNullifier(BigInt(account))); // not a real-human id
    expect((await d.store.sessionOfHuman(attestation.humanId))?.credentialLevel).toBe(3);

    // resume: same wallet, same human and session
    const again = await simulatedEnrollment(d, { account });
    expect(again.attestation.sessionRef).toBe(attestation.sessionRef);
    await d.store.close();
  });

  it("refuses a wallet already enrolled on-chain and malformed input", async () => {
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const d = await deps({ accounts: new Map(), humans: new Map([[account, `0x${"ab".repeat(32)}` as Hex]]) });
    await expect(simulatedEnrollment(d, { account })).rejects.toMatchObject({ code: "already_enrolled" });
    await expect(simulatedEnrollment(d, { account: "0x12" })).rejects.toBeInstanceOf(WorldError);
    await d.store.close();
  });

  it("the route is 404 unless WORLD_ID_MODE=simulated", async () => {
    vi.stubEnv("WORLD_ID_MODE", "real");
    const res = await simulatedRoute(new Request("http://localhost/api/enroll/simulated", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });

  it("every API response says simulated: true in simulated mode (success and error)", async () => {
    vi.stubEnv("WORLD_ID_MODE", "simulated");
    const req = (body: string) => new Request("http://localhost", { method: "POST", body });
    const ok = await handleJson("t", req("{}"), async () => null, async () => ({ fine: 1 }));
    expect(await ok.json()).toEqual({ fine: 1, simulated: true });
    const bad = await handleJson("t", req("{nope"), async () => null, async () => ({}));
    expect(await bad.json()).toMatchObject({ error: "invalid_request", simulated: true });

    vi.stubEnv("WORLD_ID_MODE", "real");
    const real = await handleJson("t", req("{}"), async () => null, async () => ({ fine: 1 }));
    expect(await real.json()).toEqual({ fine: 1 });
  });
});

describe.skipIf(!hasChain)("simulated enrollment on-chain (anvil)", () => {
  let chain: TestChain;
  beforeAll(async () => {
    chain = await startChain(attesterAccount.address);
  }, 30_000);
  afterAll(() => chain?.stop());

  it("the wallet enrolls itself at level 3 (SIMULATED) on the real HumanRegistry", async () => {
    const { client, domains } = chain;
    const d = await deps();
    const live: EnrollDeps = {
      ...d,
      registry: {
        accountOf: (h) => client.readContract({ address: domains.humanRegistry, abi: humanRegistryAbi, functionName: "accountOf", args: [h] }),
        humanOf: (a) => client.readContract({ address: domains.humanRegistry, abi: humanRegistryAbi, functionName: "humanOf", args: [a] }),
      },
      attester: createAttester(attesterAccount, domains),
      chain: { chainId: domains.chainId, humanRegistry: domains.humanRegistry },
      now: () => Math.floor(Date.now() / 1000),
    };
    const wallet = await chain.newWallet();
    const { attestation: a } = await simulatedEnrollment(live, { account: wallet.account.address });
    const hash = await wallet.writeContract({
      address: domains.humanRegistry,
      abi: humanRegistryAbi,
      functionName: "enrollAttested",
      args: [a.humanId, a.sessionRef, a.credentialLevel, BigInt(a.deadline), a.signature],
    });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");
    expect(
      await client.readContract({ address: domains.humanRegistry, abi: humanRegistryAbi, functionName: "levelOf", args: [a.humanId] }),
    ).toBe(3);
    await d.store.close();
  });
});
