import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, toHex, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { humanRegistryAbi, validationReceiptsAbi } from "@/lib/chain/abi";
import type { Domains } from "@/lib/chain/attester";

/**
 * Real contracts on anvil for tests: ANVIL_RPC_URL, or an `anvil` binary on PATH, plus a Foundry
 * build in contracts/out. `hasChain` is false when either is missing (e.g. the app CI job); the
 * contracts CI job covers the Solidity side.
 */

const OUT = path.resolve(process.cwd(), "..", "contracts", "out");
const hasArtifacts = existsSync(path.join(OUT, "HumanRegistry.sol", "HumanRegistry.json"));
const hasAnvil = !!process.env.ANVIL_RPC_URL || spawnSync("anvil", ["--version"]).status === 0;
export const hasChain = hasArtifacts && hasAnvil;
if (!hasChain) console.warn("on-chain tests skipped (need contracts/out and anvil or ANVIL_RPC_URL)");

function bytecode(name: string): Hex {
  return JSON.parse(readFileSync(path.join(OUT, `${name}.sol`, `${name}.json`), "utf8")).bytecode.object as Hex;
}

export type TestChain = {
  rpcUrl: string;
  client: PublicClient;
  domains: Domains;
  /**
   * A fresh account funded through anvil_setBalance. Every test file uses its own accounts, so
   * files running in parallel against one anvil never collide on nonces.
   */
  newWallet(): Promise<ReturnType<typeof walletFor>>;
  stop(): void;
};

const walletFor = (key: Hex, rpcUrl: string) =>
  createWalletClient({ account: privateKeyToAccount(key), chain: foundry, transport: http(rpcUrl) });

/** Deploys HumanRegistry (attester mode) and ValidationReceipts. */
export async function startChain(attester: Address): Promise<TestChain> {
  let child: ChildProcess | undefined;
  let rpcUrl = process.env.ANVIL_RPC_URL ?? "";
  if (!rpcUrl) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    child = spawn("anvil", ["--port", String(port), "--silent"], { stdio: "ignore" });
    rpcUrl = `http://127.0.0.1:${port}`;
  }
  const client = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
  for (let i = 0; ; i++) {
    try {
      await client.getChainId();
      break;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const newWallet = async () => {
    const wallet = walletFor(toHex(crypto.getRandomValues(new Uint8Array(32))), rpcUrl);
    await client.request({ method: "anvil_setBalance", params: [wallet.account.address, toHex(10n ** 18n)] } as never);
    return wallet;
  };

  const admin = await newWallet();
  const deploy = async (name: string, abi: Abi, args: unknown[]) => {
    const hash = await admin.deployContract({ abi, bytecode: bytecode(name), args });
    return (await client.waitForTransactionReceipt({ hash })).contractAddress as Address;
  };
  const verifier = "0x0000000000000000000000000000000000000001";
  const perms = "0x0000000000000000000000000000000000000002"; // not called by the paths under test
  const humanRegistry = await deploy("HumanRegistry", humanRegistryAbi, [verifier, admin.account.address]);
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
    args: [attester],
  });
  await client.waitForTransactionReceipt({ hash });

  return {
    rpcUrl,
    client,
    domains: { chainId: foundry.id, humanRegistry, validationReceipts },
    newWallet,
    stop: () => child?.kill(),
  };
}
