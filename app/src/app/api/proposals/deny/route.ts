import { handleJson } from "@/lib/http/handler";
import { proposalDeps } from "@/lib/server/approve";
import { denyProposal } from "@/lib/world/proposals";

/** Deny with new input: closes the proposal and returns the rebuilt context. No receipt. */
export async function POST(request: Request): Promise<Response> {
  return handleJson("proposals", request, proposalDeps, denyProposal);
}
