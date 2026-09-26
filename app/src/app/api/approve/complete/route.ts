import { handleJson } from "@/lib/http/handler";
import { approveDeps } from "@/lib/server/approve";
import { completeApproval } from "@/lib/world/approve";

/** Accept, step 2: World ID session proof + wallet signature → validate() → receipt id. */
export async function POST(request: Request): Promise<Response> {
  return handleJson("approve", request, approveDeps, completeApproval);
}
