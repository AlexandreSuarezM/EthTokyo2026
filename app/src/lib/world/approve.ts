import "server-only";
import {
  getAddress,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  toHex,
  zeroHash,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { z } from "zod";
import { APPROVAL_TYPES, receiptsDomain, type Attester, type Domains } from "@/lib/chain/attester";
import { RelayError, type Relayer } from "@/lib/chain/relayer";
import type { Proposal, Store } from "@/lib/db/store";
import type { WorldIdMode } from "@/lib/env";
import { SIMULATED_LEVEL } from "@/lib/enroll/service";
import { commitHashOf, repoIdOf, type RepoSource } from "@/lib/repo/source";
import { WorldError } from "@/lib/world/errors";
import { signalHash } from "@/lib/world/identity";
import { contextOf, viewOf, type ProposalView } from "@/lib/world/proposals";
import { parseClientResult, sessionResult, verifySession, type VerifyOptions } from "@/lib/world/verify";

/**
 * Accept → receipt (CC-10). Two calls:
 *
 *  prepare   re-reads the change from the repository, builds the HumanApproval (commit hash,
 *            context hash, line count all from the server), returns it for the validator's wallet
 *            to sign and a World ID signal bound to its digest
 *  complete  World ID session proof made at that moment, verified on this server
 *            → session_id → the enrolled humanId (fail closed if it maps to nobody)
 *            → the wallet signature must come from that human's enrolled account
 *            → single use: pending approval, session nullifier, and one approval key per
 *              (repo, commit, human) in the database
 *            → attester signs the HumanAttestation → relayer submits validate() → receipt id
 *
 * Every failure is a typed WorldError: no attestation, no transaction, no receipt.
 */

export const APPROVAL_TTL_SECONDS = 10 * 60;
const APPROVE_NULLIFIER_ACTION = "hitl-approve";

export type RegistryReader = { humanOf(account: Address): Promise<Hex> };

export type ApproveDeps = {
  store: Store;
  repos: RepoSource;
  verify: VerifyOptions;
  registry: RegistryReader;
  attester: Pick<Attester, "signHumanAttestation">;
  relayer: Pick<Relayer, "submitValidate">;
  chain: Domains;
  /** "simulated" (demo only): no World ID proof; only SIMULATED-level humans may approve. Default "real". */
  mode?: WorldIdMode;
  now?: () => number;
  randomId?: () => string;
  randomNonce?: () => bigint;
};

export type HumanApprovalMessage = {
  sessionId: Hex;
  repoId: Hex;
  commitHash: Hex;
  contextHash: Hex;
  modelId: Hex;
  submitter: Address;
  linesChanged: number;
  rounds: number;
  nonce: bigint;
  deadline: bigint;
};

/** JSON form of HumanApproval (uint256 as decimal strings), for the wallet and the database. */
export type HumanApprovalJson = Omit<HumanApprovalMessage, "nonce" | "deadline"> & { nonce: string; deadline: string };

export type PrepareResult = {
  approvalId: string;
  expiresAt: number;
  /** EIP-712 typed data the validator's wallet signs (convert nonce/deadline to bigint for viem). */
  typedData: {
    domain: ReturnType<typeof receiptsDomain>;
    types: typeof APPROVAL_TYPES;
    primaryType: "HumanApproval";
    message: HumanApprovalJson;
  };
  approvalDigest: Hex;
  /** Signal for the IDKit proveSession request: binds the World ID proof to this exact approval. */
  signal: string;
  proposal: ProposalView;
};

export type CompleteResult = {
  status: "recorded";
  receiptId: string;
  txHash: Hash;
  humanId: Hex;
  repo: string;
  commitHash: Hex;
};

/** Signal for the approval's session proof. */
export const approveSignal = (approvalDigest: Hex) => `hitl-approve:${approvalDigest.toLowerCase()}`;

/** One approval = one receipt: one key per (repo, commit, human), consumed once. */
export const approvalKey = (repoId: Hex, commitHash: Hex, humanId: Hex) =>
  `merge:${repoId}:${commitHash}:${humanId}`.toLowerCase();

const ID = /^[0-9a-f]{64}$/;
const prepareBody = z.strictObject({ proposalId: z.string().regex(ID) });
const completeBody = z.strictObject({
  approvalId: z.string().regex(ID),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  result: z.unknown().optional(), // required in real mode, ignored in simulated mode
});

function parseBody<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new WorldError("invalid_request", "The request is malformed.");
  return parsed.data;
}

const defaultNow = () => Math.floor(Date.now() / 1000);
const defaultRandomId = () => toHex(crypto.getRandomValues(new Uint8Array(32))).slice(2);
const defaultNonce = () => BigInt(toHex(crypto.getRandomValues(new Uint8Array(32))));

const toJson = (m: HumanApprovalMessage): HumanApprovalJson => ({ ...m, nonce: m.nonce.toString(), deadline: m.deadline.toString() });
const fromJson = (m: HumanApprovalJson): HumanApprovalMessage => ({ ...m, nonce: BigInt(m.nonce), deadline: BigInt(m.deadline) });

const digestOf = (chain: Domains, message: HumanApprovalMessage) =>
  hashTypedData({ domain: receiptsDomain(chain), types: APPROVAL_TYPES, primaryType: "HumanApproval", message });

/**
 * Re-reads the proposal's change from the repository now. The commit and what was shown must be
 * exactly what the proposal froze; anything else means the branch moved (fail closed).
 */
async function currentChange(deps: ApproveDeps, p: Proposal) {
  if (p.status !== "open") throw new WorldError("stale", "This proposal was denied or replaced.");
  const change = await deps.repos.inspect(p.repo, p.baseSha, p.headRef);
  if (change.baseSha !== p.baseSha || change.headSha !== p.headSha || change.linesChanged !== p.linesChanged) {
    throw new WorldError("stale", "The change moved since it was shown. Review it again.");
  }
  if (contextOf(p, change) !== p.contextHash) throw new WorldError("stale", "The change moved since it was shown. Review it again.");
  return change;
}

async function onChain<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new WorldError("verification_unavailable", "Could not read the registry on-chain. Try again.");
  }
}

/** Step 1 of accept: the server builds the HumanApproval from the repository, never from the client. */
export async function prepareApproval(deps: ApproveDeps, body: unknown): Promise<PrepareResult> {
  const { proposalId } = parseBody(prepareBody, body);
  const p = await deps.store.getProposal(proposalId);
  if (!p) throw new WorldError("invalid_request", "Unknown proposal.");
  const change = await currentChange(deps, p);

  const now = (deps.now ?? defaultNow)();
  const message: HumanApprovalMessage = {
    sessionId: `0x${p.threadId}`,
    repoId: repoIdOf(p.repo),
    commitHash: commitHashOf(change.headSha),
    contextHash: p.contextHash,
    modelId: keccak256(stringToHex(p.modelId)),
    submitter: getAddress(p.submitter),
    linesChanged: change.linesChanged,
    rounds: p.round - 1,
    nonce: (deps.randomNonce ?? defaultNonce)(),
    deadline: BigInt(now + APPROVAL_TTL_SECONDS),
  };
  const approvalDigest = digestOf(deps.chain, message);
  const approvalId = (deps.randomId ?? defaultRandomId)();
  const expiresAt = now + APPROVAL_TTL_SECONDS;
  const saved = await deps.store.savePendingApproval({
    id: approvalId,
    proposalId,
    message: JSON.stringify(toJson(message)),
    digest: approvalDigest,
    expiresAt,
  });
  if (!saved) throw new WorldError("verification_unavailable", "Could not prepare the approval. Try again.");

  return {
    approvalId,
    expiresAt,
    typedData: { domain: receiptsDomain(deps.chain), types: APPROVAL_TYPES, primaryType: "HumanApproval", message: toJson(message) },
    approvalDigest,
    signal: approveSignal(approvalDigest),
    proposal: viewOf(p, change.diff),
  };
}

/** Contract custom errors → typed errors. Unknown reverts are rejections (fail closed). */
export function fromRevert(name: string | undefined): WorldError {
  switch (name) {
    case "Expired":
      return new WorldError("expired", "The approval expired before it was recorded. Approve again.");
    case "NonceUsed":
    case "AlreadyValidated":
      return new WorldError("replayed", "This change was already validated by this person.");
    case "BadSignature":
    case "UnknownHuman":
      return new WorldError("not_enrolled", "The validator or the submitter is not enrolled.");
    case "Banned":
      return new WorldError("ineligible", "This validator is banned (stage 3).");
    case "InsufficientPermission":
      return new WorldError("ineligible", "This validator lacks the permission for this repository or change size.");
    case "SelfApproval":
      return new WorldError("ineligible", "Self-approval is not allowed by the policy.");
    case "LiveProofRequired":
      return new WorldError("ineligible", "This repository requires a live proof, which is not supported yet.");
    case "UnknownRepo":
      return new WorldError("ineligible", "This repository is not registered on-chain.");
    case "BadAttestation":
      return new WorldError("verification_unavailable", "The server attestation was refused. The attester is misconfigured.");
    default:
      return new WorldError("rejected", "The validation was refused on-chain.");
  }
}

/** Step 2 of accept: World ID proof at this moment + the wallet signature → one receipt. */
export async function completeApproval(deps: ApproveDeps, body: unknown): Promise<CompleteResult> {
  const { approvalId, signature, result: raw } = parseBody(completeBody, body);
  const simulated = deps.mode === "simulated";
  const result = simulated ? null : parseClientResult(sessionResult, raw);
  const now = (deps.now ?? defaultNow)();

  const pending = await deps.store.getPendingApproval(approvalId);
  if (!pending) throw new WorldError("expired", "This approval was not found or was already used. Accept again.");
  if (pending.expiresAt < now) throw new WorldError("expired", "This approval expired. Accept again.");

  // The proof must be made for this exact approval (checked before calling World).
  if (result && result.responses[0].signal_hash.toLowerCase() !== signalHash(approveSignal(pending.digest))) {
    throw new WorldError("rejected", "This World ID proof was made for a different approval.");
  }

  const message = fromJson(JSON.parse(pending.message) as HumanApprovalJson);
  const digest = digestOf(deps.chain, message);
  if (digest !== pending.digest) throw new WorldError("verification_unavailable", "The stored approval is inconsistent.");

  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      domain: receiptsDomain(deps.chain),
      types: APPROVAL_TYPES,
      primaryType: "HumanApproval",
      message,
      signature: signature as Hex,
    });
  } catch {
    throw new WorldError("invalid_request", "The wallet signature is malformed.");
  }

  let humanId: Hex;
  let sessionNullifier: string | null = null;
  let worldResult: string;
  if (result) {
    // World ID at this moment → session_id → the human stored at enrollment.
    const session = await verifySession(result, deps.verify);
    const enrolled = await deps.store.humanOfSession(session.sessionId);
    if (!enrolled) throw new WorldError("not_enrolled", "This World ID session does not belong to an enrolled person.");
    if (session.level !== enrolled.credentialLevel) {
      throw new WorldError("rejected", "The proof uses a different credential than the enrollment.");
    }
    const signerHuman = await onChain(() => deps.registry.humanOf(signer));
    if (signerHuman === zeroHash) throw new WorldError("not_enrolled", "The signing wallet is not an enrolled account.");
    if (signerHuman.toLowerCase() !== enrolled.humanId.toLowerCase()) {
      throw new WorldError("rejected", "The wallet that signed is not the account of the person who proved.");
    }
    humanId = enrolled.humanId;
    sessionNullifier = session.sessionNullifier;
    worldResult = JSON.stringify(result);
  } else {
    // Simulated mode: no World proof. Only a SIMULATED human's enrolled wallet may approve, so a
    // real (Orb / Selfie) human can never be approved for without a proof.
    const signerHuman = await onChain(() => deps.registry.humanOf(signer));
    if (signerHuman === zeroHash) throw new WorldError("not_enrolled", "The signing wallet is not an enrolled account.");
    const enrolled = await deps.store.sessionOfHuman(signerHuman);
    if (!enrolled || enrolled.credentialLevel !== SIMULATED_LEVEL) {
      throw new WorldError("not_enrolled", "Simulated mode approves only simulated humans. Real humans need a World ID proof.");
    }
    humanId = enrolled.humanId;
    worldResult = JSON.stringify({ simulated: true, approvalDigest: digest });
  }

  const proposal = await deps.store.getProposal(pending.proposalId);
  if (!proposal) throw new WorldError("verification_unavailable", "The proposal for this approval is missing.");
  const change = await currentChange(deps, proposal);
  if (commitHashOf(change.headSha) !== message.commitHash || proposal.contextHash !== message.contextHash) {
    throw new WorldError("stale", "The change moved since it was shown. Review it again.");
  }

  // Single use, in the database: the approval, the World proof, and (repo, commit, human).
  const taken = await deps.store.takePendingApproval(approvalId);
  if (!taken) throw new WorldError("replayed", "This approval was already used.");
  if (taken.expiresAt < now) throw new WorldError("expired", "This approval expired. Accept again.");
  if (sessionNullifier !== null && !(await deps.store.recordNullifier(APPROVE_NULLIFIER_ACTION, sessionNullifier, humanId))) {
    throw new WorldError("replayed", "This World ID proof was already used.");
  }
  const key = approvalKey(message.repoId, message.commitHash, humanId);
  if (!(await deps.store.consumeApproval(key))) {
    throw new WorldError("replayed", "This person already approved this change.");
  }

  // Hash of the verified World ID result (or the simulated marker); kept off-chain for audit.
  const proofRef = keccak256(stringToHex(worldResult));
  // presence = false: no repo requires a live proof (liveProofTier = 4, docs/RULES.md).
  const attestation = await deps.attester.signHumanAttestation({ approvalDigest: digest, proofRef, presence: false });

  let relayed: { txHash: Hash; receiptId: bigint };
  try {
    relayed = await deps.relayer.submitValidate([
      message,
      signature as Hex,
      { root: 0n, nullifier: 0n, proof: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] },
      { proofRef, presence: false, signature: attestation },
    ]);
  } catch (e) {
    if (e instanceof RelayError && e.code === "reverted") {
      // Simulation refused it: no transaction was sent, so the approval key can be used again.
      await deps.store.releaseApproval(key);
      throw fromRevert(e.errorName);
    }
    // A transaction may have been sent: keep the key consumed (never risk a second receipt).
    throw new WorldError("verification_unavailable", "The validation transaction did not confirm. Check the receipt before retrying.");
  }

  const receiptId = relayed.receiptId.toString();
  await deps.store.saveReceipt({
    approvalKey: key,
    receiptId,
    txHash: relayed.txHash,
    proposalId: proposal.id,
    humanId,
    proofRef,
    worldResult,
  });

  return { status: "recorded", receiptId, txHash: relayed.txHash, humanId, repo: proposal.repo, commitHash: message.commitHash };
}
