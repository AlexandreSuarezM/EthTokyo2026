import "server-only";
import { zeroAddress, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAttester } from "@/lib/chain/attester";
import type { Store } from "@/lib/db/store";
import { completeEnrollment, startEnrollment, type EnrollDeps } from "@/lib/enroll/service";
import { WorldError } from "@/lib/world/errors";

/**
 * Dev-only smoke test of enrollment against the REAL World verify API (WORLD_ENVIRONMENT).
 * Contracts aren't deployed yet, so it stops after the attester signature:
 * - nobody is enrolled on-chain (registry reads return zero),
 * - the attestation is signed for verifyingContract = 0x0, so it can never be used on-chain.
 */

export const isDev = (env: Record<string, string | undefined> = process.env) => env.NODE_ENV !== "production";

export function devEnrollDeps(opts: {
  store: Store;
  rpId: string;
  environment: EnrollDeps["verify"]["environment"];
  chainId: number;
  attesterKey: `0x${string}`;
}): EnrollDeps {
  return {
    store: opts.store,
    verify: { rpId: opts.rpId, environment: opts.environment },
    registry: { accountOf: async () => zeroAddress, humanOf: async () => zeroHash },
    attester: createAttester(privateKeyToAccount(opts.attesterKey), {
      chainId: opts.chainId,
      humanRegistry: zeroAddress,
      validationReceipts: zeroAddress,
    }),
    chain: { chainId: opts.chainId, humanRegistry: zeroAddress },
  };
}

export type DevResult =
  | { ok: true; step: "start"; status: "pending"; enrollmentId: string; sessionSignal: string; credentialLevel: 1 | 2 }
  | { ok: true; step: "start" | "complete"; status: "attested"; credentialLevel: 1 | 2; sessionIdPrefix: string; attesterSigned: true }
  | { ok: false; error: string; message: string; worldCode: string | null };

/** "session_" + the first 6 characters of the id itself; never the full session_id. */
export const sessionIdPrefix = (sessionId: string) => `${sessionId.slice(0, "session_".length + 6)}…`;

export async function runDev(step: "start" | "complete", deps: EnrollDeps, body: unknown): Promise<DevResult> {
  try {
    const res = step === "start" ? await startEnrollment(deps, body) : await completeEnrollment(deps, body);
    if (res.status === "pending") {
      return { ok: true, step: "start", status: "pending", enrollmentId: res.enrollmentId, sessionSignal: res.sessionSignal, credentialLevel: res.credentialLevel };
    }
    const session = await deps.store.sessionOfHuman(res.attestation.humanId);
    return {
      ok: true,
      step,
      status: "attested",
      credentialLevel: res.attestation.credentialLevel,
      sessionIdPrefix: session ? sessionIdPrefix(session.sessionId) : "?",
      attesterSigned: true,
    };
  } catch (e) {
    if (e instanceof WorldError) return { ok: false, error: e.code, message: e.message, worldCode: e.worldCode ?? null };
    return { ok: false, error: "unexpected", message: e instanceof Error ? e.name : "unknown", worldCode: null };
  }
}

/** Field names (and a few non-secret scalars) of what the browser sent, for dev logs. Never proofs or nullifiers. */
export function shapeOf(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  const r = (b.result ?? {}) as Record<string, unknown>;
  const item = (Array.isArray(r.responses) ? r.responses[0] : {}) as Record<string, unknown>;
  return {
    body: Object.keys(b),
    result: Object.keys(r),
    protocol_version: r.protocol_version,
    action: r.action,
    environment: r.environment,
    responses: Array.isArray(r.responses) ? r.responses.length : typeof r.responses,
    item: Object.keys(item ?? {}),
    identifier: item?.identifier,
    issuer_schema_id: item?.issuer_schema_id,
  };
}
