import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";
import { normalizeNullifier } from "@/lib/world/nullifier";

/**
 * The on-chain humanId: derived from the enrollment nullifier (one per human for the
 * "hitl-enroll" action), so the same person always maps to the same humanId and
 * HumanRegistry's one-human-one-account rule holds. Domain-separated and versioned.
 */
export function humanIdFromNullifier(nullifier: string | bigint): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "uint256" }], ["hitl.human.v1", BigInt(normalizeNullifier(nullifier))]),
  );
}

/** Signal for the enrollment uniqueness proof: binds the proof to the wallet being enrolled. */
export const enrollSignal = (account: Address) => `hitl-enroll:${getAddress(account)}`;

/** Signal for the session created during enrollment: binds it to one pending enrollment. */
export const sessionSignal = (enrollmentId: string) => `hitl-session:${enrollmentId}`;

export const signalHash = (signal: string) => hashSignal(signal).toLowerCase();
