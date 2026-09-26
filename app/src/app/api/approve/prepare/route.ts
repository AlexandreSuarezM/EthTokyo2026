import { handleJson } from "@/lib/http/handler";
import { approveDeps } from "@/lib/server/approve";
import { prepareApproval } from "@/lib/world/approve";

/** Accept, step 1: the server re-reads the change and builds the HumanApproval to sign. */
export async function POST(request: Request): Promise<Response> {
  return handleJson("approve", request, approveDeps, prepareApproval);
}
