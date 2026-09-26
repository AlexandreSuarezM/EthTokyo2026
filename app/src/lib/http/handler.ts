import "server-only";
import { simulatedMark } from "@/lib/env";
import { WorldError, errorResponse } from "@/lib/world/errors";

const noStore = { "cache-control": "no-store" };

/** Shared route logic: JSON in, typed error or result out. Unknown errors never leak details. */
export async function handleJson<D, T>(
  label: string,
  request: Request,
  deps: () => Promise<D>,
  run: (deps: D, body: unknown) => Promise<T>,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(new WorldError("invalid_request", "The request body must be JSON."));
  }
  try {
    return Response.json({ ...(await run(await deps(), body)), ...simulatedMark() }, { headers: noStore });
  } catch (e) {
    if (e instanceof WorldError) return errorResponse(e);
    console.error(`${label}: unexpected error`, e instanceof Error ? e.name : "unknown");
    return errorResponse(new WorldError("verification_unavailable", "The request failed unexpectedly. Try again."));
  }
}
