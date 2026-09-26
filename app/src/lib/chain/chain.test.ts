import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  hashTypedData,
  http,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { humanRegistryAbi, validationReceiptsAbi } from "@/lib/chain/abi";
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

// Anvil's well-known dev keys (public test accounts, never real funds).
const KEYS = {
  admin: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  attester: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  relayer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  user: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;
const attesterAccount = privateKeyToAccount(KEYS.attester);
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
      account: privateKeyToAccount(KEYS.user).address,
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

// ---------------------------------------------------------------------------------------------
// Against the real contracts on anvil: ANVIL_RPC_URL, or an `anvil` binary on PATH, plus a
// Foundry build in contracts/out. Skipped (with a note) when either is missing, e.g. in the
// app CI job; the contracts job covers the Solidity side.
const OUT = path.resolve(process.cwd(), "..", "contracts", "out");
const hasArtifacts = existsSync(path.join(OUT, "HumanRegistry.sol", "HumanRegistry.json"));
const hasAnvil = !!process.env.ANVIL_RPC_URL || spawnSync("anvil", ["--version"]).status === 0;
if (!hasArtifacts || !hasAnvil) {
  console.warn("chain.test: on-chain tests skipped (need contracts/out and anvil or ANVIL_RPC_URL)");
}

function bytecode(name: string): Hex {
  const json = JSON.parse(readFileSync(path.join(OUT, `${name}.sol`, `${name}.json`), "utf8"));
  return json.bytecode.object as Hex;
}

describe.skipIf(!hasArtifacts || !hasAnvil)("on-chain (anvil)", () => {
  let child: ChildProcess | undefined;
  let rpcUrl: string;
  let client: PublicClient;
  let domains: Domains;

  beforeAll(async () => {
    rpcUrl = process.env.ANVIL_RPC_URL ?? "";
    if (!rpcUrl) {
      const port = 20000 + Math.floor(Math.random() * 20000);
      child = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
      rpcUrl = `http://127.0.0.1:${port}`;
    }
    client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
    for (let i = 0; ; i++) {
      try {
        await client.getChainId();
        break;
      } catch (e) {
        if (i > 50) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const admin = createWalletClient({ account: privateKeyToAccount(KEYS.admin), chain: foundry, transport: http(rpcUrl) });
    const deploy = async (name: string, abi: Abi, args: unknown[]) => {
      const hash = await admin.deployContract({ abi, bytecode: bytecode(name), args });
      const { contractAddress } = await client.waitForTransactionReceipt({ hash });
      return contractAddress as Address;
    };
    const verifier = "0x0000000000000000000000000000000000000001";
    const humanRegistry = await deploy("HumanRegistry", humanRegistryAbi, [verifier, admin.account.address]);
    const perms = "0x0000000000000000000000000000000000000002"; // not called by the paths under test
    const validationReceipts = await deploy("ValidationReceipts", validationReceiptsAbi, [
      humanRegistry,
      perms,
      verifier,
      admin.account.address,
    ]);
    const hash = await admin.writeContract({
      address: humanRegistry,
      abi: humanRegistryAbi,
      functionName: "setAttester",
      args: [attesterAccount.address],
    });
    await client.waitForTransactionReceipt({ hash });
    domains = { chainId: foundry.id, humanRegistry, validationReceipts };
  }, 30_000);

  afterAll(() => {
    child?.kill();
  });

  it("computes the same EIP-712 digests as the contracts", async () => {
    const enroll = {
      account: privateKeyToAccount(KEYS.user).address,
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
    const user = createWalletClient({ account: privateKeyToAccount(KEYS.user), chain: foundry, transport: http(rpcUrl) });
    const attester = createAttester(attesterAccount, domains);
    // Fresh account per run so the test also works against a long-lived anvil (ANVIL_RPC_URL).
    const account = privateKeyToAccount(randomBytes32());
    const fund = await user.sendTransaction({ to: account.address, value: 10n ** 17n });
    await client.waitForTransactionReceipt({ hash: fund });
    const wallet = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });

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
    const wallet = createWalletClient({ account: privateKeyToAccount(KEYS.relayer), chain: foundry, transport: http(rpcUrl) });
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
