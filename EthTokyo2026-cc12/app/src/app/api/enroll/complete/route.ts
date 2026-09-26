import { handleEnroll } from "@/lib/enroll/handler";
import { completeEnrollment } from "@/lib/enroll/service";
import { enrollDeps } from "@/lib/server/enroll";

/** Step 2: verify the createSession proof, store session_id, return the attestation for enrollAttested. */
export async function POST(request: Request): Promise<Response> {
  return handleEnroll(request, enrollDeps, completeEnrollment);
}
