import { z } from "zod";
import { serverEnv } from "@/lib/server/env";
import { RP_REQUEST_KINDS, createRpContext } from "@/lib/world/rp";

// Strict: an extra field (e.g. a client-chosen "action") is rejected, not ignored.
const body = z.strictObject({ kind: z.enum(RP_REQUEST_KINDS) });

const noStore = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400, headers: noStore });
  }
  const parsed = body.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: noStore });
  }

  const env = serverEnv();
  const ctx = createRpContext(parsed.data.kind, { rpId: env.WORLD_RP_ID, signingKeyHex: env.WORLD_SIGNING_KEY });
  return Response.json(ctx, { headers: noStore });
}
