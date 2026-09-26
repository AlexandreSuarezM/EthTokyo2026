import { computeRpSignatureMessage } from "@worldcoin/idkit-core/signing";
import { hexToBytes, recoverMessageAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENROLL_ACTION, createRpContext, type RpContextResponse } from "@/lib/world/rp";

// Fresh random RP key per run: no key material in the repo.
const signingKeyHex = generatePrivateKey().slice(2);
const signer = privateKeyToAccount(`0x${signingKeyHex}`).address;
const cfg = { rpId: "rp_test123", signingKeyHex };

async function signerOf({ rp_context: c, action }: RpContextResponse) {
  const message = computeRpSignatureMessage(hexToBytes(c.nonce as Hex), c.created_at, c.expires_at, action);
  return recoverMessageAddress({ message: { raw: message }, signature: c.signature as Hex });
}

describe("createRpContext", () => {
  it("signs an enrollment request bound to the enroll action", async () => {
    const res = createRpContext("enroll", cfg);
    expect(res.action).toBe(ENROLL_ACTION);
    expect(res.rp_context.rp_id).toBe("rp_test123");
    expect(res.rp_context.expires_at - res.rp_context.created_at).toBe(300);
    expect(await signerOf(res)).toBe(signer);
  });

  it("signs a session request without an action", async () => {
    const res = createRpContext("session", cfg);
    expect(res.action).toBeUndefined();
    expect(await signerOf(res)).toBe(signer);
  });

  it("uses a fresh nonce for every request", () => {
    const nonces = new Set(Array.from({ length: 20 }, () => createRpContext("session", cfg).rp_context.nonce));
    expect(nonces.size).toBe(20);
  });
});

describe("POST /api/world/rp-context", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("WORLD_RP_ID", cfg.rpId);
    vi.stubEnv("WORLD_SIGNING_KEY", signingKeyHex);
    vi.stubEnv("ATTESTER_PRIVATE_KEY", generatePrivateKey());
    vi.stubEnv("RELAYER_PRIVATE_KEY", generatePrivateKey());
    vi.stubEnv("SEPOLIA_RPC_URL", "https://rpc.example.org");
  });
  afterEach(() => vi.unstubAllEnvs());

  const post = async (body: string) => {
    const { POST } = await import("@/app/api/world/rp-context/route");
    return POST(new Request("http://localhost/api/world/rp-context", { method: "POST", body }));
  };

  it("returns a signed rp_context and never caches it", async () => {
    const res = await post(JSON.stringify({ kind: "enroll" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const json = (await res.json()) as RpContextResponse;
    expect(json.action).toBe(ENROLL_ACTION);
    expect(await signerOf(json)).toBe(signer);
    expect(JSON.stringify(json)).not.toContain(signingKeyHex);
  });

  it("rejects a client-chosen action", async () => {
    const res = await post(JSON.stringify({ kind: "enroll", action: "merge:anything" }));
    expect(res.status).toBe(400);
  });

  it("rejects unknown kinds and invalid JSON", async () => {
    expect((await post(JSON.stringify({ kind: "admin" }))).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
  });
});
