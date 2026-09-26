import { toHex, type Address } from "viem";
import { enrollSignal, sessionSignal, signalHash } from "@/lib/world/identity";
import { ENROLL_ACTION } from "@/lib/world/rp";

/** Test fixtures shaped like IDKit 4.x results and World's /api/v4/verify answers. */

export const rand32 = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
const proof = () => Array.from({ length: 5 }, rand32);

export function uniquenessResult(opts: {
  account: Address;
  nullifier?: string;
  schema?: number;
  sybil?: number;
  action?: string;
  signal?: string;
}) {
  return {
    protocol_version: "4.0" as const,
    nonce: rand32(),
    action: opts.action ?? ENROLL_ACTION,
    responses: [
      {
        identifier: opts.schema === 11 ? "selfie" : "proof_of_human",
        signal_hash: signalHash(opts.signal ?? enrollSignal(opts.account)),
        proof: proof(),
        nullifier: opts.nullifier ?? rand32(),
        issuer_schema_id: opts.schema ?? 1,
        expires_at_min: 1_900_000_000,
        ...(opts.sybil !== undefined ? { sybil_score: opts.sybil } : {}),
      },
    ],
    environment: "production" as const,
  };
}

export const newSessionId = () => `session_${rand32().slice(2)}${rand32().slice(2)}`;

export function sessionResult(opts: { enrollmentId: string; sessionId?: string; schema?: number; sybil?: number; signal?: string; sessionNullifier?: string }) {
  return {
    protocol_version: "4.0" as const,
    nonce: rand32(),
    session_id: opts.sessionId ?? newSessionId(),
    responses: [
      {
        identifier: opts.schema === 11 ? "selfie" : "proof_of_human",
        signal_hash: signalHash(opts.signal ?? sessionSignal(opts.enrollmentId)),
        proof: proof(),
        session_nullifier: [opts.sessionNullifier ?? rand32(), rand32()] as [string, string],
        issuer_schema_id: opts.schema ?? 1,
        expires_at_min: 1_900_000_000,
        ...(opts.sybil !== undefined ? { sybil_score: opts.sybil } : {}),
      },
    ],
    environment: "production" as const,
  };
}

/** World's success answer for a forwarded result (what the Developer Portal returns). */
export function worldOk(result: { action?: string; session_id?: string; responses: { identifier: string; nullifier?: string }[] }) {
  const item = result.responses[0];
  return {
    success: true,
    ...(result.action ? { action: result.action, nullifier: item.nullifier } : {}),
    ...(result.session_id ? { session_id: result.session_id } : {}),
    created_at: "2026-09-26T10:00:00.000Z",
    environment: "production",
    results: [{ identifier: item.identifier, success: true, ...(item.nullifier ? { nullifier: item.nullifier } : {}) }],
  };
}

type Reply = { status?: number; body?: unknown; throws?: boolean; raw?: string };

/** A fetch stand-in: answers from a queue (or a function of the request) and records every call. */
export function mockFetch(reply: Reply | ((body: Record<string, unknown>) => Reply)) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url, body });
    const r = typeof reply === "function" ? reply(body) : reply;
    if (r.throws) throw new TypeError("network down");
    return new Response(r.raw ?? JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

/** Answers every verify call with World's success answer for whatever was forwarded. */
export const worldAccepts = () => mockFetch((body) => ({ body: worldOk(body as Parameters<typeof worldOk>[0]) }));
