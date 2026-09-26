/**
 * Typed World ID errors shared by the enrollment and approval flows.
 * Every error means: nothing was signed and no transaction was sent.
 */
export const WORLD_ERROR_CODES = [
  "cancelled", //              the user closed or declined the request in World App
  "expired", //                the request, RP signature or enrollment timed out
  "rejected", //               the proof failed verification, or doesn't match what we asked for
  "already_enrolled", //       this human or this wallet already has an account
  "unavailable_credential", // the user lacks the credential (e.g. no Orb), or it's not one we accept
  "invalid_request", //        malformed input from the client
  "verification_unavailable", // World's verify API is down or answered something we can't trust
  "not_enrolled", //           the proof or wallet doesn't map to an enrolled human
  "replayed", //               this proof, approval or change was already used
  "ineligible", //             enrolled, but not allowed (banned, no permission, Selfie on a high tier, ...)
  "stale", //                  the change moved since it was shown to the validator
] as const;

export type WorldErrorCode = (typeof WORLD_ERROR_CODES)[number];

const HTTP_STATUS: Record<WorldErrorCode, number> = {
  cancelled: 400,
  expired: 410,
  rejected: 422,
  already_enrolled: 409,
  unavailable_credential: 422,
  invalid_request: 400,
  verification_unavailable: 503,
  not_enrolled: 403,
  replayed: 409,
  ineligible: 403,
  stale: 409,
};

export class WorldError extends Error {
  readonly status: number;
  constructor(
    readonly code: WorldErrorCode,
    /** Safe to show the user: never contains proofs, keys or raw upstream bodies. */
    message: string,
    /** World's own error code (verify API or IDKit), when World refused. Shown only on dev pages. */
    readonly worldCode?: string,
  ) {
    super(message);
    this.name = "WorldError";
    this.status = HTTP_STATUS[code];
  }
}

export function errorResponse(e: WorldError): Response {
  return Response.json({ error: e.code, message: e.message }, { status: e.status, headers: { "cache-control": "no-store" } });
}

/**
 * Maps a World ID error code (IDKit completion error, or a per-credential `code` from the verify API)
 * to our typed error. Unknown codes are treated as a rejection (fail closed).
 */
export function fromWorldCode(code: string | undefined | null): WorldErrorCode {
  switch (code) {
    case "cancelled":
    case "user_rejected":
      return "cancelled";
    case "timeout":
    case "rp_signature_expired":
    case "timestamp_too_old":
      return "expired";
    case "credential_unavailable":
    case "world_id_4_not_available":
    case "feature_unavailable":
      return "unavailable_credential";
    case "connection_failed":
    case "inclusion_proof_pending":
      return "verification_unavailable";
    default:
      return "rejected";
  }
}
