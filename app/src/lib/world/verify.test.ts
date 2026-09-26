import { describe, expect, it } from "vitest";
import { WorldError, fromWorldCode } from "@/lib/world/errors";
import { ENROLL_ACTION } from "@/lib/world/rp";
import {
  VERIFY_URL,
  parseClientResult,
  sessionResult as sessionSchema,
  uniquenessResult as uniquenessSchema,
  verifySession,
  verifyUniqueness,
} from "@/lib/world/verify";
import { mockFetch, newSessionId, sessionResult, uniquenessResult, worldAccepts, worldOk } from "@/test/world";

const account = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const opts = (fetch: typeof globalThis.fetch) => ({ rpId: "rp_test", environment: "production" as const, fetch });

async function codeOf(p: Promise<unknown>) {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(WorldError);
  return (e as WorldError).code;
}

describe("client payload parsing", () => {
  const good = uniquenessResult({ account });

  it("accepts a World ID 4.0 uniqueness result", () => {
    expect(parseClientResult(uniquenessSchema, good).action).toBe(ENROLL_ACTION);
  });

  it("accepts extra fields World App adds and keeps them, so the result is forwarded unchanged", () => {
    const withExtra = { ...good, nonce: "0xabc", integrity_bundle: { v: 1 }, responses: [{ ...good.responses[0], merkle_root: "0x01" }] };
    expect(parseClientResult(uniquenessSchema, withExtra)).toEqual(withExtra);
  });

  it("fails closed when a field we rely on is missing or malformed", () => {
    const item = good.responses[0];
    const bad = [
      { ...good, action: undefined },
      { ...good, environment: undefined },
      { ...good, environment: "sandbox" },
      { ...good, responses: [{ ...item, signal_hash: undefined }] },
      { ...good, responses: [{ ...item, nullifier: undefined }] },
      { ...good, responses: [{ ...item, issuer_schema_id: undefined }] },
      { ...good, responses: [item, item] },
      { ...good, protocol_version: undefined },
    ];
    for (const b of bad) expect(() => parseClientResult(uniquenessSchema, b)).toThrow(WorldError);
  });

  it("refuses a legacy 3.0 proof with a specific error (one protocol version per action: 4.0)", () => {
    // Exactly the shape World App returned in the smoke test (legacy Orb fallback).
    const legacy = {
      protocol_version: "3.0",
      nonce: "0x01",
      action: ENROLL_ACTION,
      environment: "production",
      integrity_bundle: {},
      responses: [{ identifier: "orb", signal_hash: "0x02", proof: "0x03", merkle_root: "0x04", nullifier: "0x05" }],
    };
    let e: unknown;
    try {
      parseClientResult(uniquenessSchema, legacy);
    } catch (err) {
      e = err;
    }
    expect(e).toMatchObject({ code: "unavailable_credential", worldCode: "protocol_version 3.0 (only 4.0 accepted)" });
    expect(() => parseClientResult(sessionSchema, { ...legacy, session_id: "session_x" })).toThrow(/World ID 3.0/);
  });

  it("requires a well-formed session id on session results", () => {
    const s = sessionResult({ enrollmentId: "x" });
    expect(parseClientResult(sessionSchema, s).session_id).toBe(s.session_id);
    expect(() => parseClientResult(sessionSchema, { ...s, session_id: "session_123" })).toThrow(WorldError);
  });
});

describe("verifyUniqueness", () => {
  it("returns the nullifier (decimal) and level, forwarding the result to World unchanged", async () => {
    const result = { ...uniquenessResult({ account, nullifier: "0xff" }), integrity_bundle: { v: 2 } };
    const world = worldAccepts();
    const v = await verifyUniqueness(result, ENROLL_ACTION, opts(world.fetch));
    expect(v).toMatchObject({ nullifier: "255", level: 1, sybilScore: null });
    expect(world.calls[0].url).toBe(`${VERIFY_URL}/rp_test`);
    expect(world.calls[0].body).toEqual(result);
  });

  it("refuses a result from another environment instead of rewriting it, without calling World", async () => {
    const world = worldAccepts();
    const staging = { ...uniquenessResult({ account }), environment: "staging" as const };
    expect(await codeOf(verifyUniqueness(staging, ENROLL_ACTION, opts(world.fetch)))).toBe("rejected");
    expect(world.calls).toHaveLength(0);
  });

  it("maps Selfie Check to level 2 and keeps the sybil score", async () => {
    const result = uniquenessResult({ account, schema: 11, sybil: 2.1 });
    expect(await verifyUniqueness(result, ENROLL_ACTION, opts(worldAccepts().fetch))).toMatchObject({ level: 2, sybilScore: 2.1 });
  });

  it("refuses other credentials and other actions before calling World", async () => {
    const world = worldAccepts();
    expect(await codeOf(verifyUniqueness(uniquenessResult({ account, schema: 9303 }), ENROLL_ACTION, opts(world.fetch)))).toBe(
      "unavailable_credential",
    );
    expect(await codeOf(verifyUniqueness(uniquenessResult({ account, action: "merge:x" }), ENROLL_ACTION, opts(world.fetch)))).toBe(
      "rejected",
    );
    expect(await codeOf(verifyUniqueness(uniquenessResult({ account, schema: 11 }), ENROLL_ACTION, opts(world.fetch)))).toBe(
      "invalid_request", // Selfie Check without sybil_score
    );
    expect(world.calls).toHaveLength(0);
  });

  describe("fails closed on World's answer", () => {
    const result = uniquenessResult({ account });
    const ok = worldOk(result);
    const cases: [string, Parameters<typeof mockFetch>[0], string][] = [
      ["wrong environment", { body: { ...ok, environment: "staging" } }, "rejected"],
      ["extra field is fine, but a missing environment is not", { body: { ...ok, surprise: true, environment: undefined } }, "verification_unavailable"],
      ["missing nullifier", { body: { ...ok, nullifier: undefined } }, "verification_unavailable"],
      ["missing results", { body: { ...ok, results: [] } }, "verification_unavailable"],
      ["success not true", { body: { ...ok, success: false } }, "verification_unavailable"],
      ["different nullifier", { body: { ...ok, nullifier: "0x1234" } }, "rejected"],
      ["different action", { body: { ...ok, action: "other" } }, "rejected"],
      ["a credential failed", { body: { ...ok, results: [{ identifier: "x", success: false, code: "user_rejected" }] } }, "cancelled"],
      ["expired signature", { status: 400, body: { code: "all_verifications_failed", results: [{ code: "rp_signature_expired" }] } }, "expired"],
      ["rejected proof", { status: 400, body: { code: "all_verifications_failed", results: [{ code: "invalid_proof" }] } }, "rejected"],
      ["app not migrated", { status: 400, body: { code: "app_not_migrated" } }, "verification_unavailable"],
      ["unknown app", { status: 404, body: { code: "not_found" } }, "verification_unavailable"],
      ["server error", { status: 500, body: {} }, "verification_unavailable"],
      ["not JSON", { raw: "<html>" }, "verification_unavailable"],
      ["network error", { throws: true }, "verification_unavailable"],
    ];
    it.each(cases)("%s", async (_name, reply, code) => {
      expect(await codeOf(verifyUniqueness(result, ENROLL_ACTION, opts(mockFetch(reply).fetch)))).toBe(code);
    });
  });
});

describe("verifySession", () => {
  it("returns the session id, level and session nullifier", async () => {
    const result = sessionResult({ enrollmentId: "x", sessionNullifier: "0x10" });
    const v = await verifySession(result, opts(worldAccepts().fetch));
    expect(v).toMatchObject({ sessionId: result.session_id, level: 1, sessionNullifier: "16" });
  });

  it("fails closed when World's session id is missing or different", async () => {
    const result = sessionResult({ enrollmentId: "x" });
    const ok = worldOk(result);
    expect(await codeOf(verifySession(result, opts(mockFetch({ body: { ...ok, session_id: undefined } }).fetch)))).toBe(
      "verification_unavailable",
    );
    expect(await codeOf(verifySession(result, opts(mockFetch({ body: { ...ok, session_id: newSessionId() } }).fetch)))).toBe(
      "rejected",
    );
  });
});

describe("fromWorldCode", () => {
  it("maps World and IDKit codes, and treats unknown codes as a rejection", () => {
    expect(fromWorldCode("cancelled")).toBe("cancelled");
    expect(fromWorldCode("timeout")).toBe("expired");
    expect(fromWorldCode("credential_unavailable")).toBe("unavailable_credential");
    expect(fromWorldCode("something_new")).toBe("rejected");
    expect(fromWorldCode(undefined)).toBe("rejected");
  });
});

describe("World's own error code (for dev pages)", () => {
  const errOf = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e)) as WorldError;

  it("carries World's code and HTTP status, never proof values", async () => {
    const r = uniquenessResult({ account });
    const refused = mockFetch({ status: 403, body: { code: "environment_not_allowed", detail: "..." } });
    expect((await errOf(verifyUniqueness(r, ENROLL_ACTION, opts(refused.fetch)))).worldCode).toBe("HTTP 403 environment_not_allowed");

    const failed = mockFetch({ status: 400, body: { code: "all_verifications_failed", results: [{ code: "verification_failed" }] } });
    expect((await errOf(verifyUniqueness(r, ENROLL_ACTION, opts(failed.fetch)))).worldCode).toBe("HTTP 400 verification_failed");
  });

  it("names missing fields in World's answer and in the client result, never values", async () => {
    const r = uniquenessResult({ account });
    const missing = mockFetch({ body: { ...worldOk(r), environment: undefined } });
    const e = await errOf(verifyUniqueness(r, ENROLL_ACTION, opts(missing.fetch)));
    expect(e.worldCode).toBe("unexpected fields: environment");
    expect(e.worldCode).not.toContain(r.responses[0].nullifier);

    const client = (() => {
      try {
        parseClientResult(uniquenessSchema, { ...r, responses: [{ ...r.responses[0], nullifier: undefined }] });
      } catch (err) {
        return err as WorldError;
      }
    })();
    expect(client?.worldCode).toBe("result fields: responses.0.nullifier");
  });
});
