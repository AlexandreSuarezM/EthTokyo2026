import "server-only";
import path from "node:path";
import { humanRegistryAbi } from "@/lib/chain/abi";
import { withDemoRepo } from "@/lib/demo/ai";
import type { Store } from "@/lib/db/store";
import { localGitSource, noRepoSource, type RepoSource } from "@/lib/repo/source";
import { chainServices } from "@/lib/server/chain";
import { serverEnv } from "@/lib/server/env";
import { getStore } from "@/lib/server/store";
import type { ApproveDeps } from "@/lib/world/approve";
import type { ProposalDeps } from "@/lib/world/proposals";

/** The demo repo (fake AI answers), plus local checkouts under REPOS_ROOT; nothing else (fail closed). */
function repoSource(store: Store): RepoSource {
  const root = serverEnv().REPOS_ROOT;
  return withDemoRepo(store, root ? localGitSource(path.resolve(root)) : noRepoSource);
}

export async function proposalDeps(): Promise<ProposalDeps> {
  const store = await getStore();
  return { store, repos: repoSource(store) };
}

/** Approval dependencies wired from the server env, config/<CHAIN_ID>.json and DATABASE_URL. */
export async function approveDeps(): Promise<ApproveDeps> {
  const env = serverEnv();
  const { config, attester, relayer, publicClient } = chainServices();
  const registry = config.contracts.HumanRegistry;
  const store = await getStore();
  return {
    store,
    repos: repoSource(store),
    // One config value: WORLD_ENVIRONMENT decides which World environment the server accepts.
    verify: { rpId: env.WORLD_RP_ID, environment: env.WORLD_ENVIRONMENT },
    registry: {
      humanOf: (account) =>
        publicClient.readContract({ address: registry, abi: humanRegistryAbi, functionName: "humanOf", args: [account] }),
    },
    attester,
    relayer,
    chain: { chainId: env.CHAIN_ID, humanRegistry: registry, validationReceipts: config.contracts.ValidationReceipts },
    mode: env.WORLD_ID_MODE,
  };
}
