import "server-only";
import { humanRegistryAbi } from "@/lib/chain/abi";
import type { EnrollDeps } from "@/lib/enroll/service";
import { chainServices } from "@/lib/server/chain";
import { serverEnv } from "@/lib/server/env";
import { getStore } from "@/lib/server/store";

/** Enrollment dependencies wired from the server env, config/<CHAIN_ID>.json and DATABASE_URL. */
export async function enrollDeps(): Promise<EnrollDeps> {
  const env = serverEnv();
  const { config, attester, publicClient } = chainServices();
  const registry = config.contracts.HumanRegistry;
  return {
    store: await getStore(),
    verify: { rpId: env.WORLD_RP_ID, environment: env.WORLD_ENVIRONMENT },
    registry: {
      accountOf: (humanId) =>
        publicClient.readContract({ address: registry, abi: humanRegistryAbi, functionName: "accountOf", args: [humanId] }),
      humanOf: (account) =>
        publicClient.readContract({ address: registry, abi: humanRegistryAbi, functionName: "humanOf", args: [account] }),
    },
    attester,
    chain: { chainId: env.CHAIN_ID, humanRegistry: registry },
  };
}
