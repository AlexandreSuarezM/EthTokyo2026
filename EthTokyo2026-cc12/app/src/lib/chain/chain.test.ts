import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  toHex,
  zeroAddress,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { humanRegistryAbi, validationReceiptsAbi } from "@/lib/chain/abi";
import { hasChain, startChain, type TestChain } from "@/test/anvil";
import {
  APPROVAL_TYPES,
  ATTESTATION_TYPES,
  ENROLL_TYPES,
  ROTATE_TYPES,
  createAttester,
  receiptsDomain,
  registryDomain,
  sessionRefOf,
  type Domains,
} from "@/lib/chain/attester";
import { loadChainConfig } from "@/lib/chain/config";
import { RelayError, createRelayer } from "@/lib/chain/relayer";

const attesterAccount = privateKeyToAccount(generatePrivateKey());
const randomBytes32 = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

describe("attester (offline)", () => {
  const domains: Domains = {
    chainId: 11155111,
    humanRegistry: "0x00000000000000000000000000000000000000A1",
    validationReceipts: "0x00000000000000000000000000000000000000B2",
  };
  const attester = createAttester(attesterAccount, domains);

  it("derives the on-chain session reference from the session id", () => {
    expect(sessionRefOf("session_abc")).toBe(keccak256(stringToHex("session_abc")));
  });

  it("signs enrollments that recover to the attester, bound to the registry domain", async () => {
    const message = {
      account: privateKeyToAccount(generatePrivateKey()).address,
      humanId: randomBytes32(),
      sessionRef: sessionRefOf("session_abc"),
      credentialLevel: 1 as const,
      deadline: 1_900_000_000n,
    };
    const signature = await attester.signEnroll(message);
    const recovered = await recoverTypedDataAddress({
      domain: registryDomain(domains),
      types: ENROLL_TYPES,
      primaryType: "AttestedEnroll",
      message,
      signature,
    });
    expect(recovered).toBe(attesterAccount.address);
    // The same message on another chain is a different digest (no cross-chain replay).
    const elsewhere = await recoverTypedDataAddress({
      domain: registryDomain({ ...domains, chainId: 1 }),
      types: ENROLL_TYPES,
      primaryType: "AttestedEnroll",
      message,
      signature,
    });
    expect(elsewhere).not.toBe(attesterAccount.address);
  });
});

describe("loadChainConfig", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hitl-config-"));
  const base = {
    chainId: 31337,
    environment: "team-default",
    dryRun: false,
    attester: attesterAccount.address.toLowerCase(),
    contracts: {
      HumanRegistry: "0xcc4c8af3781f1040769a6ecaa4f1b71f2e9bb50f",
      PenaltyLedger: "0x1DBabEBd14E4b9DEA2BfB5756a42F5eceE7972c9",
      PermissionRegistry: "0xB927206e478D6b232bdb3E8a000a0666e684908e",
      ValidationReceipts: "0x6Bd731269F5531597941a32d913faCCFaE2a9595",
    },
  };
  const write = (name: string, value: unknown) => writeFileSync(path.join(dir, name), JSON.stringify(value));

  it("reads and checksums addresses", () => {
    write("31337.json", base);
    const cfg = loadChainConfig(31337, dir);
    expect(cfg.contracts.HumanRegistry).toBe("0xCc4C8af3781f1040769A6ecAa4f1B71F2e9bB50f");
    expect(cfg.attester).toBe(attesterAccount.address);
  });

  it("refuses a missing file, a dry run, a chain mismatch and a bad address", () => {
    expect(() => loadChainConfig(5, dir)).toThrow(/No deployment config/);
    write("1.json", { ...base, chainId: 1, dryRun: true });
    expect(() => loadChainConfig(1, dir)).toThrow(/dry run/);
    write("2.json", { ...base, chainId: 3 });
    expect(() => loadChainConfig(2, dir)).toThrow(/is for chain 3/);
    write("4.json", { ...base, chainId: 4, contracts: { ...base.contracts, HumanRegistry: "0x123" } });
    expect(() => loadChainConfig(4, dir)).toThrow();
  });
});

describe.skipIf(!hasChain)("on-chain (anvil)", () => {
  let chain: TestChain;
  let client: PublicClient;
  let domains: Domains;

  beforeAll(async () => {
    chain = await startChain(attesterAccount.address);
    ({ client, domains } = chain);
  }, 30_000);

  afterAll(() => chain?.stop());

  it("computes the same EIP-712 digests as the contracts", async () => {
    const enroll = {
      account: privateKeyToAccount(generatePrivateKey()).address,
      humanId: randomBytes32(),
      sessionRef: randomBytes32(),
      credentialLevel: 2 as const,
      deadline: 1_900_000_000n,
    };
    expect(
      hashTypedData({ domain: registryDomain(domains), types: ENROLL_TYPES, primaryType: "AttestedEnroll", message: enroll }),
    ).toBe(
      await client.readContract({
        address: domains.humanRegistry,
        abi: humanRegistryAbi,
        functionName: "enrollDigest",
        args: [enroll.account, enroll.humanId, enroll.sessionRef, enroll.credentialLevel, enroll.deadline],
      }),
    );

    const rotate = { newAccount: enroll.account, humanId: enroll.humanId, sessionRef: enroll.sessionRef, deadline: 5n };
    expect(
      hashTypedData({ domain: registryDomain(domains), types: ROTATE_TYPES, primaryType: "AttestedRotate", message: rotate }),
    ).toBe(
      await client.readContract({
        address: domains.humanRegistry,
        abi: humanRegistryAbi,
        functionName: "rotateDigest",
        args: [rotate.newAccount, rotate.humanId, rotate.sessionRef, rotate.deadline],
      }),
    );

    const approval = {
      sessionId: randomBytes32(),
      repoId: keccak256(stringToHex("acme/web")),
      commitHash: randomBytes32(),
      contextHash: randomBytes32(),
      modelId: keccak256(stringToHex("model")),
      submitter: enroll.account,
      linesChanged: 42,
      rounds: 2,
      nonce: 7n,
      deadline: 1_900_000_000n,
    };
    const approvalDigest = hashTypedData({
      domain: receiptsDomain(domains),
      types: APPROVAL_TYPES,
      primaryType: "HumanApproval",
      message: approval,
    });
    expect(approvalDigest).toBe(
      await client.readContract({
        address: domains.validationReceipts,
        abi: validationReceiptsAbi,
        functionName: "approvalDigest",
        args: [approval],
      }),
    );

    const att = { approvalDigest, proofRef: randomBytes32(), presence: false };
    expect(
      hashTypedData({ domain: receiptsDomain(domains), types: ATTESTATION_TYPES, primaryType: "HumanAttestation", message: att }),
    ).toBe(
      await client.readContract({
        address: domains.validationReceipts,
        abi: validationReceiptsAbi,
        functionName: "attestationDigest",
        args: [att.approvalDigest, att.proofRef, att.presence],
      }),
    );
  });

  it("enrolls a human with an attester signature sent from the human's own wallet", async () => {
    const attester = createAttester(attesterAccount, domains);
    const wallet = await chain.newWallet();
    const account = wallet.account;

    const humanId = randomBytes32();
    const sessionRef = sessionRefOf("session_test");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const sig = await attester.signEnroll({ account: account.address, humanId, sessionRef, credentialLevel: 1, deadline });

    const hash = await wallet.writeContract({
      address: domains.humanRegistry,
      abi: humanRegistryAbi,
      functionName: "enrollAttested",
      args: [humanId, sessionRef, 1, deadline, sig],
    });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");

    const read = (functionName: "humanOf" | "levelOf" | "sessionRefOf", arg: Hex) =>
      client.readContract({ address: domains.humanRegistry, abi: humanRegistryAbi, functionName, args: [arg] } as never);
    expect(await read("humanOf", account.address)).toBe(humanId);
    expect(await read("levelOf", humanId)).toBe(1);
    expect(await read("sessionRefOf", humanId)).toBe(sessionRef);
  });

  it("relayer: a call that would revert becomes a typed error and no transaction", async () => {
    const wallet = await chain.newWallet();
    const relayer = createRelayer({ wallet, publicClient: client, receipts: domains.validationReceipts });
    const nonceBefore = await client.getTransactionCount({ address: relayer.address });

    const expired = {
      sessionId: randomBytes32(),
      repoId: randomBytes32(),
      commitHash: randomBytes32(),
      contextHash: randomBytes32(),
      modelId: randomBytes32(),
      submitter: zeroAddress,
      linesChanged: 1,
      rounds: 0,
      nonce: 1n,
      deadline: 1n, // long past
    };
    const live = { root: 0n, nullifier: 0n, proof: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] as const };
    const att = { proofRef: randomBytes32(), presence: false, signature: "0x" as Hex };

    const error = await relayer.submitValidate([expired, "0x", live, att]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RelayError);
    expect(error).toMatchObject({ code: "reverted", errorName: "Expired" });
    expect(await client.getTransactionCount({ address: relayer.address })).toBe(nonceBefore);
  });
});
