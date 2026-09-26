import { onboard } from "@/lib/demo/service";
import { handleJson } from "@/lib/http/handler";
import { demoDeps } from "@/lib/server/demo";

export async function POST(request: Request): Promise<Response> {
  return handleJson("demo", request, demoDeps, onboard);
}
