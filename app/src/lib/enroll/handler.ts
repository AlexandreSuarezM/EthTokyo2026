import "server-only";
import type { EnrollDeps } from "@/lib/enroll/service";
import { WorldError, errorResponse } from "@/lib/world/errors";

const noStore = { "cache-control": "no-store" };

/** Shared route logic: JSON in, typed error or result out. Unknown errors never leak details. */
export async function handleEnroll<T>(
  request: Request,
  deps: () => Promise<EnrollDeps>,
  run: (deps: EnrollDeps, body: unknown) => Promise<T>,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(new WorldError("invalid_request", "The request body must be JSON."));
  }
  try {
    return Response.json(await run(await deps(), body), { headers: noStore });
  } catch (e) {
    if (e instanceof WorldError) return errorResponse(e);
    console.error("enroll: unexpected error", e instanceof Error ? e.name : "unknown");
    return errorResponse(new WorldError("verification_unavailable", "Enrollment failed unexpectedly. Try again."));
  }
}
