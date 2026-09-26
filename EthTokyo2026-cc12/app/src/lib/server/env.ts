import "server-only";
import { parseServerEnv, type ServerEnv } from "@/lib/env";

let cached: ServerEnv | undefined;

/** The validated server environment. Importing this module from a client component fails the build. */
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
