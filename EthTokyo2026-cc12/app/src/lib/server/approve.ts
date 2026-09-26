import "server-only";
import path from "node:path";
import { humanRegistryAbi } from "@/lib/chain/abi";
import { localGitSource, noRepoSource, type RepoSource } from "@/lib/repo/source";
import { chainServices } from "@/lib/server/chain";
import { serverEnv } from "@/lib/server/env";
import { getStore } from "@/lib/server/store";
import type { ApproveDeps } from "@/lib/world/approve";
import type { ProposalDeps } from "@/lib/world/proposals";

/** Local checkouts under REPOS_ROOT; with none configured every approval fails closed. */
function repoSource(): RepoSource {
  const root = serverEnv().REPOS_ROOT;
  return root ? localGitSource(path.resolve(root)) : noRepoSource;
}

export async function proposalDeps(): Promise<ProposalDeps> {
  return { store: await getStore(), repos: repoSource() };
}

/** Approval dependencies wired from the server env, config/<CHAIN_ID>.json and DATABASE_URL. */
export async function approveDeps(): Promise<ApproveDeps> {
  const env = serverEnv();
  const { config, attester, relayer, publicClient } = chainServices();
  const registry = config.contracts.HumanRegistry;
  return {
    store: await getStore(),
    repos: repoSource(),
    // One config value: WORLD_ENVIRONMENT decides which World environment the server accepts.
    verify: { rpId: env.WORLD_RP_ID, environment: env.WORLD_ENVIRONMENT },
    registry: {
      humanOf: (account) =>
        publicClient.readContract({ address: registry, abi: humanRegistryAbi, functionName: "humanOf", args: [account] }),
    },
    attester,
    relayer,
    chain: { chainId: env.CHAIN_ID, humanRegistry: registry, validationReceipts: config.contracts.ValidationReceipts },
  };
}
