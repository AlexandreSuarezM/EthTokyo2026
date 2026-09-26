import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as devStart } from "@/app/api/dev/enroll/start/route";
import { sqliteDriver } from "@/lib/db/drivers";
import { createStore } from "@/lib/db/store";
import { devEnrollDeps, isDev, runDev, sessionIdPrefix } from "@/lib/dev/enroll";
import { mockFetch, newSessionId, sessionResult, uniquenessResult, worldAccepts } from "@/test/world";

const account = privateKeyToAccount(generatePrivateKey()).address;

async function deps(fetch = worldAccepts().fetch) {
  const store = await createStore(await sqliteDriver("file::memory:"));
  const d = devEnrollDeps({ store, rpId: "rp_test", environment: "production", chainId: 11155111, attesterKey: generatePrivateKey() });
  return { ...d, verify: { ...d.verify, fetch } };
}

afterEach(() => vi.unstubAllEnvs());

describe("dev enrollment smoke test", () => {
  it("is off in production: the route answers 404 before touching env or World", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isDev()).toBe(false);
    const res = await devStart(new Request("http://localhost/api/dev/enroll/start", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });

  it("runs start + complete and shows only a session_id prefix and the level", async () => {
    const d = await deps();
    const start = await runDev("start", d, { account, result: uniquenessResult({ account }) });
    if (!start.ok || start.status !== "pending") throw new Error("expected pending");
    const sessionId = newSessionId();
    const done = await runDev("complete", d, { enrollmentId: start.enrollmentId, result: sessionResult({ enrollmentId: start.enrollmentId, sessionId }) });
    expect(done).toEqual({ ok: true, step: "complete", status: "attested", credentialLevel: 1, sessionIdPrefix: sessionIdPrefix(sessionId), attesterSigned: true });
    expect(sessionIdPrefix(sessionId)).toBe(`${sessionId.slice(0, 14)}…`);
    expect(JSON.stringify(done)).not.toContain(sessionId);
    await d.store.close();
  });

  it("returns World's exact error code on failure", async () => {
    const d = await deps(mockFetch({ status: 400, body: { code: "all_verifications_failed", results: [{ code: "user_rejected" }] } }).fetch);
    const res = await runDev("start", d, { account, result: uniquenessResult({ account }) });
    expect(res).toEqual({ ok: false, error: "cancelled", message: "World ID did not accept this proof.", worldCode: "HTTP 400 user_rejected" });
    await d.store.close();
  });
});
