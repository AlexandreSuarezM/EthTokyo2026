// Fail fast: the server refuses to start with a missing or malformed environment.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { serverEnv } = await import("@/lib/server/env");
    if (serverEnv().WORLD_ID_MODE === "simulated") {
      console.warn(
        "WARNING: WORLD_ID_MODE=simulated. World ID proofs are SKIPPED; humans enroll at the SIMULATED level " +
          "(never Orb) and every API response says simulated: true. Demo only, never in production.",
      );
    }
  }
}
