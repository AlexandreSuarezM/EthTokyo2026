import "server-only";
import { z } from "zod";
import { normalizeNullifier } from "@/lib/world/nullifier";
import { WorldError, fromWorldCode } from "@/lib/world/errors";

/**
 * Server-side verification of IDKit results with World's Developer Portal.
 * https://docs.world.org/api-reference/developer-portal/verify
 *
 * World is the judge of the proof: the client's result is forwarded to World unchanged, whatever
 * extra fields World App adds. Our schemas only require the fields WE depend on (protocol version,
 * action, environment, signal, nullifier / session_id, credential) and fail closed if any of those
 * is missing, malformed, or not what we asked for.
 *
 * One protocol version per action: World ID 4.0 only. A legacy 3.0 proof of the same person has a
 * different nullifier for the same action, so accepting both would allow two accounts per human;
 * and sessions exist only in 4.0 (docs/DECISIONS.md, "One protocol version").
 */

export const VERIFY_URL = "https://developer.world.org/api/v4/verify";
export const WORLD_ENVIRONMENTS = ["production", "staging"] as const;
export type WorldEnvironment = (typeof WORLD_ENVIRONMENTS)[number];
export const PROTOCOL_VERSION = "4.0";

/** issuer_schema_id → HumanRegistry credential level (1 = ORB / Proof of Human, 2 = SELFIE). */
export const LEVEL_BY_SCHEMA: Record<number, 1 | 2> = { 1: 1, 11: 2 };

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);

// ------------------------------------------------------------------ client payloads (IDKit results)
// looseObject: unknown fields pass through untouched and are forwarded to World as-is.
const uniquenessItem = z.looseObject({
  signal_hash: hex,
  nullifier: hex,
  issuer_schema_id: z.number().int(),
  sybil_score: z.number().optional(),
});

/** World ID 4.0 uniqueness proof: only the fields we rely on are required. */
export const uniquenessResult = z.looseObject({
  protocol_version: z.literal(PROTOCOL_VERSION),
  action: z.string().min(1),
  environment: z.enum(WORLD_ENVIRONMENTS),
  responses: z.array(uniquenessItem).length(1),
});
export type UniquenessResult = z.infer<typeof uniquenessResult>;

const sessionItem = z.looseObject({
  signal_hash: hex,
  session_nullifier: z.array(hex).min(1),
  issuer_schema_id: z.number().int(),
  sybil_score: z.number().optional(),
});

export const SESSION_ID = /^session_[0-9a-f]{128}$/;

/** World ID 4.0 session proof (createSession / proveSession): only the fields we rely on are required. */
export const sessionResult = z.looseObject({
  protocol_version: z.literal(PROTOCOL_VERSION),
  session_id: z.string().regex(SESSION_ID),
  environment: z.enum(WORLD_ENVIRONMENTS),
  responses: z.array(sessionItem).length(1),
});
export type SessionResult = z.infer<typeof sessionResult>;

// ------------------------------------------------------------------ World's answer
const verifyResultItem = z.looseObject({
  success: z.boolean(),
  code: z.string().optional(),
});

const verifySuccess = z.looseObject({
  success: z.literal(true),
  action: z.string().optional(),
  nullifier: z.string().optional(),
  environment: z.enum(["production", "staging", "sandbox"]),
  session_id: z.string().optional(),
  results: z.array(verifyResultItem).min(1),
});

const verifyFailure = z.looseObject({
  code: z.string().optional(),
  detail: z.string().optional(),
  results: z.array(z.looseObject({ code: z.string().optional() })).optional(),
});

export type VerifyOptions = {
  rpId: string;
  environment: WorldEnvironment;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export function parseClientResult<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const version = (input as { protocol_version?: unknown } | null)?.protocol_version;
  if (version !== undefined && version !== PROTOCOL_VERSION) {
    throw new WorldError(
      "unavailable_credential",
      version === "3.0"
        ? "World App sent a legacy World ID 3.0 proof. This app accepts World ID 4.0 only: update World App and try again."
        : "This World ID protocol version is not accepted.",
      `protocol_version ${String(version)} (only ${PROTOCOL_VERSION} accepted)`,
    );
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || i.code))];
    throw new WorldError("invalid_request", "The World ID result is malformed or not a World ID 4.0 proof.", `result fields: ${fields.join(", ")}`);
  }
  return parsed.data;
}

async function callVerify(payload: { environment: string }, opts: VerifyOptions) {
  // The client can't pick "staging"/"sandbox" (they accept test proofs): refuse, don't rewrite,
  // so what World checks is exactly what World App produced.
  if (payload.environment !== opts.environment) {
    throw new WorldError("rejected", "The proof is from the wrong World ID environment.", `environment ${payload.environment}`);
  }
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${VERIFY_URL}/${encodeURIComponent(opts.rpId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload), // unchanged: World is the judge of the proof
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch {
    throw new WorldError("verification_unavailable", "Could not reach World ID verification. Try again.");
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new WorldError("verification_unavailable", "World ID verification returned an unreadable answer.");
  }

  if (!res.ok) {
    const failure = verifyFailure.safeParse(body);
    const code = failure.success ? (failure.data.results?.find((r) => r.code)?.code ?? failure.data.code) : undefined;
    const worldCode = `HTTP ${res.status}${code ? ` ${code}` : ""}`;
    if (res.status === 400) {
      if (code === "app_not_migrated") throw new WorldError("verification_unavailable", "World ID app is misconfigured.", worldCode);
      throw new WorldError(fromWorldCode(code), "World ID did not accept this proof.", worldCode);
    }
    throw new WorldError("verification_unavailable", "World ID verification is unavailable.", worldCode);
  }

  const ok = verifySuccess.safeParse(body);
  if (!ok.success) {
    // Field names only (never values), so a dev page can show what didn't match.
    const fields = [...new Set(ok.error.issues.map((i) => i.path.join(".") || i.code))];
    throw new WorldError("verification_unavailable", "World ID verification answered with unexpected fields.", `unexpected fields: ${fields.join(", ")}`);
  }
  const v = ok.data;
  if (v.environment !== opts.environment) {
    throw new WorldError("rejected", "The proof is from the wrong World ID environment.", `environment ${v.environment}`);
  }
  const failed = v.results.find((r) => !r.success);
  if (failed) throw new WorldError(fromWorldCode(failed.code), "World ID did not accept this proof.", failed.code ?? "result failed");
  return v;
}

/** Verifies a uniqueness proof for `expectedAction`. Returns the nullifier (decimal) and credential level. */
export async function verifyUniqueness(result: UniquenessResult, expectedAction: string, opts: VerifyOptions) {
  if (result.action !== expectedAction) throw new WorldError("rejected", "The proof is for a different action.");
  const item = result.responses[0];
  const level = LEVEL_BY_SCHEMA[item.issuer_schema_id];
  if (!level) throw new WorldError("unavailable_credential", "This credential is not accepted. Use Proof of Human or Selfie Check.");
  if (level === 2 && item.sybil_score === undefined) throw new WorldError("invalid_request", "Selfie Check result is missing sybil_score.");

  const v = await callVerify(result, opts);
  if (v.action !== expectedAction) throw new WorldError("rejected", "World ID verified a different action.");
  if (!v.nullifier) throw new WorldError("verification_unavailable", "World ID verification did not return a nullifier.");
  const nullifier = normalizeNullifier(v.nullifier);
  if (nullifier !== normalizeNullifier(item.nullifier)) throw new WorldError("rejected", "The verified nullifier does not match the proof.");

  return { nullifier, level, sybilScore: item.sybil_score ?? null, signalHash: item.signal_hash.toLowerCase() };
}

/** Verifies a session proof. Returns the session_id (the account id), level and session nullifier. */
export async function verifySession(result: SessionResult, opts: VerifyOptions) {
  const item = result.responses[0];
  const level = LEVEL_BY_SCHEMA[item.issuer_schema_id];
  if (!level) throw new WorldError("unavailable_credential", "This credential is not accepted. Use Proof of Human or Selfie Check.");

  const v = await callVerify(result, opts);
  if (!v.session_id || !SESSION_ID.test(v.session_id)) {
    throw new WorldError("verification_unavailable", "World ID verification did not return a session id.");
  }
  if (v.session_id !== result.session_id) throw new WorldError("rejected", "The verified session does not match the proof.");

  return {
    sessionId: v.session_id,
    level,
    sessionNullifier: normalizeNullifier(item.session_nullifier[0]),
    sybilScore: item.sybil_score ?? null,
    signalHash: item.signal_hash.toLowerCase(),
  };
}
