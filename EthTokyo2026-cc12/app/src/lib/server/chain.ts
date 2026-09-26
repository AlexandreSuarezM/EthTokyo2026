import "server-only";
import { createPublicClient, createWalletClient, defineChain, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry, sepolia } from "viem/chains";
import { createAttester } from "@/lib/chain/attester";
import { loadChainConfig } from "@/lib/chain/config";
import { createRelayer } from "@/lib/chain/relayer";
import { serverEnv } from "@/lib/server/env";

function chainFor(id: number, rpcUrl: string): Chain {
  if (id === sepolia.id) return sepolia;
  if (id === foundry.id) return foundry;
  return defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
}

/** Attester and relayer wired from the server env and config/<CHAIN_ID>.json. */
export function chainServices() {
  const env = serverEnv();
  const cfg = loadChainConfig(env.CHAIN_ID);
  const chain = chainFor(env.CHAIN_ID, env.SEPOLIA_RPC_URL);
  const transport = http(env.SEPOLIA_RPC_URL);

  const attesterAccount = privateKeyToAccount(env.ATTESTER_PRIVATE_KEY);
  if (attesterAccount.address !== cfg.attester) {
    throw new Error(`ATTESTER_PRIVATE_KEY does not match the deployed attester in config/${env.CHAIN_ID}.json`);
  }
  const attester = createAttester(attesterAccount, {
    chainId: env.CHAIN_ID,
    humanRegistry: cfg.contracts.HumanRegistry,
    validationReceipts: cfg.contracts.ValidationReceipts,
  });

  const publicClient = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account: privateKeyToAccount(env.RELAYER_PRIVATE_KEY), chain, transport });
  const relayer = createRelayer({ wallet, publicClient, receipts: cfg.contracts.ValidationReceipts });

  return { config: cfg, attester, relayer, publicClient };
}
