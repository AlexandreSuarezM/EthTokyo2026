import "server-only";
import { keccak256, stringToHex, type Address, type Hex, type LocalAccount } from "viem";
import type { CredentialLevel } from "@/lib/db/store";

/**
 * EIP-712 attestations signed by the backend attester, matching the contracts exactly:
 * - HumanRegistry        domain ("HITLHumanRegistry", "1"): AttestedEnroll, AttestedRotate
 * - ValidationReceipts   domain ("HITLValidationReceipts", "1"): HumanAttestation
 * The attester only signs after the World ID result was verified on the server.
 */

export const ENROLL_TYPES = {
  AttestedEnroll: [
    { name: "account", type: "address" },
    { name: "humanId", type: "bytes32" },
    { name: "sessionRef", type: "bytes32" },
    { name: "credentialLevel", type: "uint8" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const ROTATE_TYPES = {
  AttestedRotate: [
    { name: "newAccount", type: "address" },
    { name: "humanId", type: "bytes32" },
    { name: "sessionRef", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const ATTESTATION_TYPES = {
  HumanAttestation: [
    { name: "approvalDigest", type: "bytes32" },
    { name: "proofRef", type: "bytes32" },
    { name: "presence", type: "bool" },
  ],
} as const;

export const APPROVAL_TYPES = {
  HumanApproval: [
    { name: "sessionId", type: "bytes32" },
    { name: "repoId", type: "bytes32" },
    { name: "commitHash", type: "bytes32" },
    { name: "contextHash", type: "bytes32" },
    { name: "modelId", type: "bytes32" },
    { name: "submitter", type: "address" },
    { name: "linesChanged", type: "uint32" },
    { name: "rounds", type: "uint16" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export type Domains = { chainId: number; humanRegistry: Address; validationReceipts: Address };

export const registryDomain = (d: Domains) =>
  ({ name: "HITLHumanRegistry", version: "1", chainId: d.chainId, verifyingContract: d.humanRegistry }) as const;

export const receiptsDomain = (d: Domains) =>
  ({ name: "HITLValidationReceipts", version: "1", chainId: d.chainId, verifyingContract: d.validationReceipts }) as const;

/** On-chain reference to a World ID session: keccak256 of the session_id string (never the raw id). */
export const sessionRefOf = (sessionId: string): Hex => keccak256(stringToHex(sessionId));

export type EnrollAttestation = {
  account: Address;
  humanId: Hex;
  sessionRef: Hex;
  credentialLevel: CredentialLevel;
  deadline: bigint;
};

export type RotateAttestation = { newAccount: Address; humanId: Hex; sessionRef: Hex; deadline: bigint };

export type HumanAttestation = { approvalDigest: Hex; proofRef: Hex; presence: boolean };

export function createAttester(signer: LocalAccount, domains: Domains) {
  return {
    address: signer.address,
    signEnroll: (m: EnrollAttestation) =>
      signer.signTypedData({ domain: registryDomain(domains), types: ENROLL_TYPES, primaryType: "AttestedEnroll", message: m }),
    signRotate: (m: RotateAttestation) =>
      signer.signTypedData({ domain: registryDomain(domains), types: ROTATE_TYPES, primaryType: "AttestedRotate", message: m }),
    signHumanAttestation: (m: HumanAttestation) =>
      signer.signTypedData({
        domain: receiptsDomain(domains),
        types: ATTESTATION_TYPES,
        primaryType: "HumanAttestation",
        message: m,
      }),
  };
}

export type Attester = ReturnType<typeof createAttester>;
