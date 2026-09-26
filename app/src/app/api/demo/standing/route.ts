import { simulatedMark } from "@/lib/env";
import { standing } from "@/lib/demo/service";
import { demoDeps } from "@/lib/server/demo";
import { WorldError, errorResponse } from "@/lib/world/errors";

/** GET /api/demo/standing?account=0x...: score, stage, tokens, restriction countdown, receipts. */
export async function GET(request: Request): Promise<Response> {
  try {
    const account = new URL(request.url).searchParams.get("account") ?? "";
    return Response.json({ ...(await standing(await demoDeps(), account)), ...simulatedMark() }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof WorldError) return errorResponse(e);
    console.error("demo standing: unexpected error", e instanceof Error ? e.message.slice(0, 200) : "unknown");
    return errorResponse(new WorldError("verification_unavailable", "Could not read your standing. Try again."));
  }
}
