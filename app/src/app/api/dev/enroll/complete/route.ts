import { devEnrollDeps, isDev, runDev } from "@/lib/dev/enroll";
import { serverEnv } from "@/lib/server/env";
import { getStore } from "@/lib/server/store";

/** Dev only (404 in production): enrollment step "complete" against the real World verify API. */
export async function POST(request: Request): Promise<Response> {
  if (!isDev()) return new Response("Not found", { status: 404 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid_request", message: "The request body must be JSON.", worldCode: null }, { status: 400 });
  }
  const env = serverEnv();
  const deps = devEnrollDeps({
    store: await getStore(),
    rpId: env.WORLD_RP_ID,
    environment: env.WORLD_ENVIRONMENT,
    chainId: env.CHAIN_ID,
    attesterKey: env.ATTESTER_PRIVATE_KEY,
  });
  const result = await runDev("complete", deps, body);
  return Response.json(result, { status: result.ok ? 200 : 422, headers: { "cache-control": "no-store" } });
}
