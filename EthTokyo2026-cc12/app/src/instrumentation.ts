// Fail fast: the server refuses to start with a missing or malformed environment.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { serverEnv } = await import("@/lib/server/env");
    serverEnv();
  }
}
