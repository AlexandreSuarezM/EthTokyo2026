import "server-only";
import { isAddress, getAddress, toHex, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { z } from "zod";
import { sessionRefOf, type Attester } from "@/lib/chain/attester";
import type { CredentialLevel, Store } from "@/lib/db/store";
import { WorldError } from "@/lib/world/errors";
import { enrollSignal, humanIdFromNullifier, sessionSignal, signalHash } from "@/lib/world/identity";
import { ENROLL_ACTION } from "@/lib/world/rp";
import {
  parseClientResult,
  sessionResult,
  uniquenessResult,
  verifySession,
  verifyUniqueness,
  type VerifyOptions,
} from "@/lib/world/verify";

/**
 * Enrollment (CC-9). Two World ID proofs, both verified on this server:
 *
 *  start     uniqueness proof, action "hitl-enroll", signal bound to the wallet
 *            → nullifier → humanId (one per human) → pending enrollment
 *  complete  createSession proof, signal bound to the pending enrollment
 *            → session_id = the account id → stored once → attester signs enrollAttested
 *
 * The human's own wallet then sends HumanRegistry.enrollAttested (it enrolls msg.sender).
 * Any error: nothing stored (except a pending enrollment), nothing signed, no transaction.
 */

export const PENDING_TTL_SECONDS = 10 * 60;
export const ATTESTATION_TTL_SECONDS = 30 * 60;
const SESSION_NULLIFIER_ACTION = "session";

export type RegistryReader = {
  accountOf(humanId: Hex): Promise<Address>;
  humanOf(account: Address): Promise<Hex>;
};

export type EnrollDeps = {
  store: Store;
  verify: VerifyOptions;
  registry: RegistryReader;
  attester: Attester;
  chain: { chainId: number; humanRegistry: Address };
  now?: () => number;
  randomId?: () => string;
};

export type EnrollAttestation = {
  chainId: number;
  humanRegistry: Address;
  account: Address;
  humanId: Hex;
  sessionRef: Hex;
  credentialLevel: CredentialLevel;
  deadline: string; // uint256 as a decimal string (JSON has no bigint)
  signature: Hex;
};

export type StartResult =
  | { status: "pending"; enrollmentId: string; humanId: Hex; credentialLevel: CredentialLevel; expiresAt: number; sessionSignal: string }
  | { status: "attested"; attestation: EnrollAttestation };

export type CompleteResult = { status: "attested"; attestation: EnrollAttestation };

const address = z.string().refine((v) => isAddress(v, { strict: false })).transform((v) => getAddress(v));
const startBody = z.strictObject({ account: address, result: z.unknown() });
const completeBody = z.strictObject({ enrollmentId: z.string().regex(/^[0-9a-f]{64}$/), result: z.unknown() });

function parseBody<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new WorldError("invalid_request", "The request is malformed.");
  return parsed.data;
}

const defaultNow = () => Math.floor(Date.now() / 1000);
const defaultRandomId = () => toHex(crypto.getRandomValues(new Uint8Array(32))).slice(2);

async function onChain<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new WorldError("verification_unavailable", "Could not read the registry on-chain. Try again.");
  }
}

async function assertNotEnrolledOnChain(deps: EnrollDeps, humanId: Hex, account: Address) {
  if ((await onChain(() => deps.registry.accountOf(humanId))) !== zeroAddress) {
    throw new WorldError("already_enrolled", "This person is already enrolled.");
  }
  if ((await onChain(() => deps.registry.humanOf(account))) !== zeroHash) {
    throw new WorldError("already_enrolled", "This wallet is already enrolled.");
  }
}

async function attest(
  deps: EnrollDeps,
  m: { account: Address; humanId: Hex; sessionId: string; credentialLevel: CredentialLevel },
): Promise<EnrollAttestation> {
  const deadline = BigInt((deps.now ?? defaultNow)() + ATTESTATION_TTL_SECONDS);
  const sessionRef = sessionRefOf(m.sessionId);
  const signature = await deps.attester.signEnroll({
    account: m.account,
    humanId: m.humanId,
    sessionRef,
    credentialLevel: m.credentialLevel,
    deadline,
  });
  return {
    chainId: deps.chain.chainId,
    humanRegistry: deps.chain.humanRegistry,
    account: m.account,
    humanId: m.humanId,
    sessionRef,
    credentialLevel: m.credentialLevel,
    deadline: deadline.toString(),
    signature,
  };
}

export async function startEnrollment(deps: EnrollDeps, body: unknown): Promise<StartResult> {
  const { account, result: raw } = parseBody(startBody, body);
  const result = parseClientResult(uniquenessResult, raw);

  if (result.responses[0].signal_hash.toLowerCase() !== signalHash(enrollSignal(account))) {
    throw new WorldError("rejected", "This proof was made for a different wallet.");
  }

  const { nullifier, level, sybilScore } = await verifyUniqueness(result, ENROLL_ACTION, deps.verify);
  const humanId = humanIdFromNullifier(nullifier);
  await assertNotEnrolledOnChain(deps, humanId, account);

  // Verified before but the wallet never sent the transaction: re-issue the attestation.
  const existing = await deps.store.sessionOfHuman(humanId);
  if (existing) {
    if (getAddress(existing.account) !== account) {
      throw new WorldError("already_enrolled", "This person started enrollment with another wallet.");
    }
    return {
      status: "attested",
      attestation: await attest(deps, { account, humanId, sessionId: existing.sessionId, credentialLevel: existing.credentialLevel }),
    };
  }

  const id = (deps.randomId ?? defaultRandomId)();
  const expiresAt = (deps.now ?? defaultNow)() + PENDING_TTL_SECONDS;
  const saved = await deps.store.savePending({
    id,
    humanId,
    enrollNullifier: nullifier,
    account,
    credentialLevel: level,
    sybilScore,
    expiresAt,
  });
  if (!saved) throw new WorldError("verification_unavailable", "Could not start enrollment. Try again.");

  return { status: "pending", enrollmentId: id, humanId, credentialLevel: level, expiresAt, sessionSignal: sessionSignal(id) };
}

export async function completeEnrollment(deps: EnrollDeps, body: unknown): Promise<CompleteResult> {
  const { enrollmentId, result: raw } = parseBody(completeBody, body);
  const result = parseClientResult(sessionResult, raw);
  const now = (deps.now ?? defaultNow)();

  const pending = await deps.store.getPending(enrollmentId);
  if (!pending) throw new WorldError("expired", "This enrollment was not found or was already completed. Start again.");
  if (pending.expiresAt < now) throw new WorldError("expired", "This enrollment expired. Start again.");

  if (result.responses[0].signal_hash.toLowerCase() !== signalHash(sessionSignal(enrollmentId))) {
    throw new WorldError("rejected", "This session proof was made for a different enrollment.");
  }

  const session = await verifySession(result, deps.verify);
  if (session.level !== pending.credentialLevel) {
    throw new WorldError("rejected", "The session uses a different credential than the enrollment proof.");
  }

  // Single use: only one request can take the pending enrollment.
  const taken = await deps.store.takePending(enrollmentId);
  if (!taken) throw new WorldError("rejected", "This enrollment was already completed.");
  if (taken.expiresAt < now) throw new WorldError("expired", "This enrollment expired. Start again.");

  if (!(await deps.store.recordNullifier(SESSION_NULLIFIER_ACTION, session.sessionNullifier, taken.humanId))) {
    throw new WorldError("rejected", "This session proof was already used.");
  }

  const account = getAddress(taken.account);
  await assertNotEnrolledOnChain(deps, taken.humanId, account);

  const saved = await deps.store.saveSession({
    humanId: taken.humanId,
    sessionId: session.sessionId,
    account,
    credentialLevel: taken.credentialLevel,
    enrollNullifier: taken.enrollNullifier,
    sybilScore: taken.sybilScore,
  });
  if (!saved) {
    if (await deps.store.sessionOfHuman(taken.humanId)) throw new WorldError("already_enrolled", "This person is already enrolled.");
    throw new WorldError("rejected", "This World ID session already belongs to another account.");
  }

  return {
    status: "attested",
    attestation: await attest(deps, {
      account,
      humanId: taken.humanId,
      sessionId: session.sessionId,
      credentialLevel: taken.credentialLevel,
    }),
  };
}
