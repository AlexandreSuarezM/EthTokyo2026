import { notFound } from "next/navigation";
import { getAddress, toHex } from "viem";
import { isDev } from "@/lib/dev/enroll";
import { serverEnv } from "@/lib/server/env";
import DevEnroll from "./DevEnroll";

export const dynamic = "force-dynamic";

/** Dev-only smoke test: real World ID enrollment, stopping after the attester signature. */
export default function Page() {
  if (!isDev()) notFound();
  const appId = process.env.NEXT_PUBLIC_WORLD_APP_ID;
  if (!appId?.startsWith("app_")) return <p style={{ padding: 24 }}>NEXT_PUBLIC_WORLD_APP_ID is not set.</p>;
  // A throwaway address: the uniqueness proof is bound to it by its signal. No wallet needed.
  const account = getAddress(toHex(crypto.getRandomValues(new Uint8Array(20))));
  return <DevEnroll appId={appId as `app_${string}`} environment={serverEnv().WORLD_ENVIRONMENT} account={account} />;
}
