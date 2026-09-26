import "server-only";
import type { EnrollDeps } from "@/lib/enroll/service";
import { handleJson } from "@/lib/http/handler";

/** Enrollment routes: JSON in, typed error or result out. */
export const handleEnroll = <T>(request: Request, deps: () => Promise<EnrollDeps>, run: (deps: EnrollDeps, body: unknown) => Promise<T>) =>
  handleJson("enroll", request, deps, run);
