import { readFileSync } from "node:fs";
import path from "node:path";
import { getAddress, isAddress } from "viem";
import { z } from "zod";

const address = z.string().refine((v) => isAddress(v, { strict: false }), "not an address").transform((v) => getAddress(v));

const schema = z.object({
  chainId: z.number().int().positive(),
  environment: z.string(),
  blockNumber: z.number().int().nonnegative().optional(), // deploy block: where event scans start
  operator: address.optional(), // relayer; in the demo also the judge
  dryRun: z.boolean(),
  attester: address,
  contracts: z.object({
    HumanRegistry: address,
    PermissionRegistry: address,
    ValidationReceipts: address,
    PenaltyLedger: address,
  }),
});

export type ChainConfig = z.infer<typeof schema>;

/** Repo-level config/ directory, written by contracts/script/Deploy.s.sol. */
export const CONFIG_DIR = path.resolve(process.cwd(), "..", "config");

/**
 * Deployed addresses for a chain, from config/<chainId>.json. Never hard-code addresses.
 * Refuses dry-run output and a file whose chainId doesn't match the one asked for.
 */
export function loadChainConfig(chainId: number, dir: string = CONFIG_DIR): ChainConfig {
  const file = path.join(dir, `${chainId}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`No deployment config for chain ${chainId} (expected config/${chainId}.json)`);
  }
  const cfg = schema.parse(raw);
  if (cfg.chainId !== chainId) throw new Error(`config/${chainId}.json is for chain ${cfg.chainId}`);
  if (cfg.dryRun) throw new Error(`config/${chainId}.json is a dry run, not a deployment`);
  return cfg;
}

const rewardsSchema = z.object({
  chainId: z.number().int().positive(),
  ChallengeRewards: address,
  deadline: z.number().int().positive(),
  cooldown: z.number().int().nonnegative(),
  threshold: z.number().int().positive(),
});
export type RewardsConfig = z.infer<typeof rewardsSchema>;

/** Optional ChallengeRewards deployment (config/<chainId>.rewards.json, written by DeployRewards.s.sol). */
export function loadRewardsConfig(chainId: number, dir: string = CONFIG_DIR): RewardsConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(dir, `${chainId}.rewards.json`), "utf8"));
  } catch {
    return null;
  }
  const cfg = rewardsSchema.parse(raw);
  if (cfg.chainId !== chainId) throw new Error(`config/${chainId}.rewards.json is for chain ${cfg.chainId}`);
  return cfg;
}
