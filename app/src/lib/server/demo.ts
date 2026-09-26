import "server-only";
import {
  createWalletClient,
  keccak256,
  parseEventLogs,
  stringToHex,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { challengeRewardsAbi, humanRegistryAbi, penaltyLedgerAbi, permissionRegistryAbi, validationReceiptsAbi } from "@/lib/chain/abi";
import { loadRewardsConfig } from "@/lib/chain/config";
import { RelayError } from "@/lib/chain/relayer";
import type { ChainReads, ChainWrites, DemoDeps } from "@/lib/demo/service";
import { approveDeps } from "@/lib/server/approve";
import { chainServices } from "@/lib/server/chain";
import { serverEnv } from "@/lib/server/env";
import { getStore } from "@/lib/server/store";

const VALIDATOR_PRESET = keccak256(stringToHex("validator"));

/** Demo dependencies on the configured chain (Sepolia: config/11155111.json). */
export async function demoDeps(): Promise<DemoDeps> {
  const env = serverEnv();
  const { config, publicClient, relayerWallet, chain, transport } = chainServices();
  const c = config.contracts;
  const store = await getStore();
  const rw = loadRewardsConfig(env.CHAIN_ID)?.ChallengeRewards ?? null;
  const read = <T>(address: Address, abi: Abi, functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address, abi, functionName, args } as never) as Promise<T>;

  /** Simulate first: a call that would revert becomes a typed error and never a transaction. */
  const send = async (wallet: typeof relayerWallet, address: Address, abi: Abi, functionName: string, args: unknown[]) => {
    let request;
    try {
      ({ request } = await publicClient.simulateContract({ account: wallet.account, address, abi, functionName, args } as never));
    } catch (err) {
      const e = err as { walk?: (fn: (x: unknown) => boolean) => unknown };
      const revert = e.walk?.((x) => (x as { data?: { errorName?: string } })?.data?.errorName !== undefined) as
        | { data?: { errorName?: string } }
        | undefined;
      throw new RelayError("reverted", revert?.data?.errorName); // no transaction was sent
    }
    const hash = await wallet.writeContract(request as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new RelayError("failed", undefined, hash);
    return receipt;
  };

  const stage2At = async () => Number(((await read<readonly unknown[]>(c.PenaltyLedger, penaltyLedgerAbi, "config")) as readonly unknown[])[4]);

  const reads: ChainReads = {
    humanOf: (a) => read<Hex>(c.HumanRegistry, humanRegistryAbi, "humanOf", [a]),
    levelOf: async (h) => Number(await read<number>(c.HumanRegistry, humanRegistryAbi, "levelOf", [h])),
    stageOf: async (h) => Number(await read<number>(c.PenaltyLedger, penaltyLedgerAbi, "stageOf", [h])),
    scoreOf: (h) => read<bigint>(c.PenaltyLedger, penaltyLedgerAbi, "scoreOf", [h]),
    penaltyCount: async (h) => Number(await read<number>(c.PenaltyLedger, penaltyLedgerAbi, "penaltyCount", [h])),
    isBannedForever: (h) => read<boolean>(c.PenaltyLedger, penaltyLedgerAbi, "isBannedForever", [h]),
    secondsRestricted: async (h) => {
      const stage = Number(await read<number>(c.PenaltyLedger, penaltyLedgerAbi, "stageOf", [h]));
      if (stage < 2) return 0;
      const s = await read<bigint>(c.PenaltyLedger, penaltyLedgerAbi, "secondsUntilBelow", [h, await stage2At()]);
      return s > 10n ** 12n ? 0 : Number(s);
    },
    hasValidatorPreset: async (h) =>
      (await read<bigint>(c.PermissionRegistry, permissionRegistryAbi, "activeValue", [
        h,
        await read<Hex>(c.PermissionRegistry, permissionRegistryAbi, "REPO_TIER"),
      ])) > 0n,
    receiptContextHash: async (id) =>
      ((await read<{ contextHash: Hex }>(c.ValidationReceipts, validationReceiptsAbi, "receiptOf", [id])) as { contextHash: Hex }).contextHash,
    // No event scans: free-tier RPCs cap eth_getLogs at 10 blocks. Every penalty in the demo is minted
    // by our judge, so the token ids come from our judgments; the mint time is read on-chain.
    penalties: async (h) => {
      const out = [];
      for (const r of await store.receiptsOfHuman(h)) {
        const j = await store.getJudgment(r.receiptId);
        if (!j?.tokenId || !j.txHash) continue;
        const p = await read<{ mintedAt: bigint }>(c.PenaltyLedger, penaltyLedgerAbi, "penaltyOf", [BigInt(j.tokenId)]);
        out.push({ tokenId: j.tokenId, receiptId: r.receiptId, mintedAt: Number(p.mintedAt), txHash: j.txHash });
      }
      return out;
    },
    lifts: (h) => store.liftsOf(h),
    rewards: async (h) => {
      if (!rw) return null;
      const r = <T>(fn: string, args: unknown[] = []) => read<T>(rw, challengeRewardsAbi, fn, args);
      const [points, threshold, cooldown, next, optedIn, claimed, count, deadline, share, pool] = await Promise.all([
        r<number>("pointsOf", [h]),
        r<number>("threshold"),
        r<bigint>("cooldown"),
        r<bigint>("secondsUntilNextPoint", [h]),
        r<boolean>("optedIn", [h]),
        r<boolean>("claimed", [h]),
        r<bigint>("optedInCount"),
        r<bigint>("deadline"),
        r<bigint>("shareOf"),
        publicClient.getBalance({ address: rw }),
      ]);
      return {
        points: Number(points),
        threshold: Number(threshold),
        cooldown: Number(cooldown),
        secondsUntilNextPoint: Number(next),
        optedIn,
        claimed,
        optedInCount: Number(count),
        deadline: Number(deadline),
        poolWei: pool.toString(),
        shareWei: share.toString(),
        contract: rw,
      };
    },
  };

  const writes: ChainWrites = {
    penalize: async (receiptId, evidenceHash) => {
      const r = await send(relayerWallet, c.ValidationReceipts, validationReceiptsAbi, "oraclePenalize", [receiptId, evidenceHash, false]);
      const [ev] = parseEventLogs({ abi: penaltyLedgerAbi, eventName: "Penalized", logs: r.logs });
      return { tokenId: ev ? (ev as unknown as { args: { tokenId: bigint } }).args.tokenId.toString() : "?", txHash: r.transactionHash };
    },
    lift: async (human, reasonHash) => (await send(relayerWallet, c.PenaltyLedger, penaltyLedgerAbi, "judgeLift", [human, reasonHash])).transactionHash as Hash,
    ...(rw
      ? {
          award: async (human: Hex, receiptId: bigint) => {
            try {
              const r = await send(relayerWallet, rw, challengeRewardsAbi, "award", [human, receiptId]);
              return { awarded: true as const, txHash: r.transactionHash as Hash };
            } catch (e) {
              if (e instanceof RelayError && e.errorName === "CooldownActive") {
                return { awarded: false as const, reason: "No point this time: one point per cooldown (difficulty)." };
              }
              if (e instanceof RelayError && e.errorName === "DeadlinePassed") return { awarded: false as const, reason: "The challenge deadline has passed." };
              throw e;
            }
          },
          slash: async (human: Hex, reasonHash: Hex) =>
            (await send(relayerWallet, rw, challengeRewardsAbi, "slash", [human, reasonHash])).transactionHash as Hash,
        }
      : {}),
    grantValidator: async (human) => {
      if (!env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY is not set");
      const admin = createWalletClient({ account: privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY), chain, transport });
      return (await send(admin as typeof relayerWallet, c.PermissionRegistry, permissionRegistryAbi, "applyPreset", [human, VALIDATOR_PRESET]))
        .transactionHash as Hash;
    },
  };

  return { store, approve: await approveDeps(), reads, writes };
}

/** Public facts for the page (addresses and explorer only; nothing secret). */
export function demoPublicConfig() {
  const env = serverEnv();
  const { config } = chainServices();
  return {
    chainId: env.CHAIN_ID,
    mode: env.WORLD_ID_MODE,
    worldEnvironment: env.WORLD_ENVIRONMENT,
    explorer: env.CHAIN_ID === 11155111 ? "https://sepolia.etherscan.io" : null,
    contracts: config.contracts,
    rewards: loadRewardsConfig(env.CHAIN_ID)?.ChallengeRewards ?? null,
    judge: config.operator ?? null,
  };
}
