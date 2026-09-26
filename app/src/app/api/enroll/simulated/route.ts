import { isSimulated } from "@/lib/env";
import { handleEnroll } from "@/lib/enroll/handler";
import { simulatedEnrollment } from "@/lib/enroll/service";
import { enrollDeps } from "@/lib/server/enroll";

/** WORLD_ID_MODE=simulated only: enroll a wallet without a World ID proof (level SIMULATED). 404 otherwise. */
export async function POST(request: Request): Promise<Response> {
  if (!isSimulated()) return new Response("Not found", { status: 404 });
  return handleEnroll(request, enrollDeps, simulatedEnrollment);
}
