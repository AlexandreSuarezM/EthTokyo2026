import "server-only";
import { signRequest } from "@worldcoin/idkit-core/signing";

/** Action for the one-time Proof of Human at enrollment (uniqueness proof, one nullifier per human). */
export const ENROLL_ACTION = "hitl-enroll";

/**
 * What the client may ask a signature for. The client never chooses the action:
 * - "enroll": uniqueness proof bound to ENROLL_ACTION;
 * - "session": session proof (createSession / proveSession). Session requests carry no action
 *   (https://docs.world.org/world-id/idkit/session-proofs); identity comes from the stored session_id.
 */
export const RP_REQUEST_KINDS = ["enroll", "session"] as const;
export type RpRequestKind = (typeof RP_REQUEST_KINDS)[number];

/** Shape IDKit expects as `rp_context` (https://docs.world.org/world-id/idkit/integrate, step 4). */
export type RpContext = {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
};

export type RpContextResponse = { rp_context: RpContext; action?: string };

const TTL_SECONDS = 300;

/** Signs a fresh request: signRequest draws a new random nonce on every call. */
export function createRpContext(
  kind: RpRequestKind,
  cfg: { rpId: string; signingKeyHex: string },
  sign: typeof signRequest = signRequest,
): RpContextResponse {
  const action = kind === "enroll" ? ENROLL_ACTION : undefined;
  const { sig, nonce, createdAt, expiresAt } = sign({
    signingKeyHex: cfg.signingKeyHex,
    action,
    ttl: TTL_SECONDS,
  });
  return {
    rp_context: { rp_id: cfg.rpId, nonce, created_at: createdAt, expires_at: expiresAt, signature: sig },
    ...(action ? { action } : {}),
  };
}
