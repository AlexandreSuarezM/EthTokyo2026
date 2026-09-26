import { handleEnroll } from "@/lib/enroll/handler";
import { startEnrollment } from "@/lib/enroll/service";
import { enrollDeps } from "@/lib/server/enroll";

/** Step 1: verify the enrollment uniqueness proof (action "hitl-enroll", signal = the wallet). */
export async function POST(request: Request): Promise<Response> {
  return handleEnroll(request, enrollDeps, startEnrollment);
}
