import "server-only";
import { getAddress, isAddress, keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import { z } from "zod";
import type { Proposal, Store } from "@/lib/db/store";
import { commitHashOf, repoIdOf, type Change, type RepoSource } from "@/lib/repo/source";
import { WorldError } from "@/lib/world/errors";

/**
 * Proposals (CC-10): what the validator is shown before accepting or denying.
 *
 *  open    the agent committed a change on a branch; the server reads base..head from the
 *          repository itself (sha, diff, line count) and freezes the context hash
 *  deny    the validator's new input closes the proposal. No receipt, nothing on-chain.
 *          The next round is a NEW proposal whose context is rebuilt from the base task plus
 *          every deny input so far, not from an ever-growing transcript.
 *  revise  opens that next round (one revision per deny, enforced by a unique key)
 *
 * Accepting is in approve.ts.
 */

export const MAX_ROUNDS = 100; // HumanApproval.rounds is a uint16; keep it far below
export const MAX_TEXT = 8000;
export const MAX_LINES = 2 ** 32 - 1; // HumanApproval.linesChanged is a uint32

export type ProposalDeps = {
  store: Store;
  repos: RepoSource;
  now?: () => number;
  randomId?: () => string;
};

/** What a validator sees and what the agent needs for the next round. */
export type ProposalView = {
  id: string;
  threadId: string;
  round: number;
  repo: string;
  repoId: Hex;
  baseSha: string;
  headSha: string;
  commitHash: Hex;
  linesChanged: number;
  contextHash: Hex;
  task: string;
  feedback: string[];
  diff: string;
};

export type DenyResult = {
  status: "denied";
  proposalId: string;
  /** Rebuilt context for the agent's next attempt: base task + every deny input so far. */
  next: { parentId: string; repo: string; baseSha: string; task: string; feedback: string[]; round: number };
};

const ID = /^[0-9a-f]{64}$/;
const text = z.string().trim().min(1).max(MAX_TEXT);
const address = z.string().refine((v) => isAddress(v, { strict: false })).transform((v) => getAddress(v));

export const openInput = z.strictObject({
  repo: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  task: text,
  modelId: z.string().min(1).max(200),
  submitter: address,
});
export const reviseInput = z.strictObject({
  parentId: z.string().regex(ID),
  headRef: z.string(),
  modelId: z.string().min(1).max(200),
});
const denyBody = z.strictObject({ proposalId: z.string().regex(ID), input: text });

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new WorldError("invalid_request", "The request is malformed.");
  return parsed.data;
}

const defaultRandomId = () => toHex(crypto.getRandomValues(new Uint8Array(32))).slice(2);

/**
 * keccak256 of exactly what the validator is shown: the task, every earlier deny input, the round,
 * and the diff read from the repository. Recorded on-chain as HumanApproval.contextHash, so an
 * audit can check what the approver actually saw.
 */
export function contextOf(
  p: { repo: string; task: string; feedback: string[]; round: number },
  change: Pick<Change, "baseSha" | "headSha" | "diff" | "commitment">,
): Hex {
  if (change.commitment) return change.commitment; // demo: hash(code, verdict, salt), sealed by the server
  const shown = {
    v: "hitl.context.v1",
    repo: p.repo,
    base: change.baseSha,
    head: change.headSha,
    task: p.task,
    feedback: p.feedback,
    round: p.round,
    diff: change.diff,
  };
  return keccak256(stringToHex(JSON.stringify(shown)));
}

export function viewOf(p: Proposal, diff: string): ProposalView {
  return {
    id: p.id,
    threadId: p.threadId,
    round: p.round,
    repo: p.repo,
    repoId: repoIdOf(p.repo),
    baseSha: p.baseSha,
    headSha: p.headSha,
    commitHash: commitHashOf(p.headSha),
    linesChanged: p.linesChanged,
    contextHash: p.contextHash,
    task: p.task,
    feedback: p.feedback,
    diff,
  };
}

async function readChange(repos: RepoSource, repo: string, baseRef: string, headRef: string): Promise<Change> {
  const change = await repos.inspect(repo, baseRef, headRef);
  if (change.baseSha === change.headSha || change.diff === "") throw new WorldError("invalid_request", "The proposal has no changes.");
  if (change.linesChanged > MAX_LINES) throw new WorldError("invalid_request", "The change is too large.");
  return change;
}

async function save(deps: ProposalDeps, p: Omit<Proposal, "status" | "denyInput" | "createdAt">, diff: string) {
  if (!(await deps.store.saveProposal(p))) throw new WorldError("replayed", "This proposal was already revised.");
  const saved = await deps.store.getProposal(p.id);
  if (!saved) throw new WorldError("verification_unavailable", "Could not store the proposal. Try again.");
  return viewOf(saved, diff);
}

/** Round 1: the agent's first change for a task. */
export async function openProposal(deps: ProposalDeps, input: z.input<typeof openInput>): Promise<ProposalView> {
  const i = parse(openInput, input);
  const change = await readChange(deps.repos, i.repo, i.baseRef, i.headRef);
  const id = (deps.randomId ?? defaultRandomId)();
  const base = { repo: i.repo, task: i.task, feedback: [] as string[], round: 1 };
  return save(
    deps,
    {
      ...base,
      id,
      threadId: id,
      parentId: null,
      baseSha: change.baseSha,
      headRef: i.headRef,
      headSha: change.headSha,
      linesChanged: change.linesChanged,
      contextHash: contextOf(base, change),
      modelId: i.modelId,
      submitter: i.submitter,
    },
    change.diff,
  );
}

/** The validator denies with new input: closes the proposal, returns the rebuilt context. No receipt. */
export async function denyProposal(deps: ProposalDeps, body: unknown): Promise<DenyResult> {
  const { proposalId, input } = parse(denyBody, body);
  const denied = await deps.store.denyProposal(proposalId, input);
  if (!denied) {
    const p = await deps.store.getProposal(proposalId);
    if (!p) throw new WorldError("invalid_request", "Unknown proposal.");
    throw new WorldError("stale", "This proposal was already denied.");
  }
  return {
    status: "denied",
    proposalId,
    next: {
      parentId: denied.id,
      repo: denied.repo,
      baseSha: denied.baseSha,
      task: denied.task,
      feedback: [...denied.feedback, input],
      round: denied.round + 1,
    },
  };
}

/** The next round after a deny: a new proposal on the same task and base, with all feedback. */
export async function reviseProposal(deps: ProposalDeps, input: z.input<typeof reviseInput>): Promise<ProposalView> {
  const i = parse(reviseInput, input);
  const parent = await deps.store.getProposal(i.parentId);
  if (!parent) throw new WorldError("invalid_request", "Unknown proposal.");
  if (parent.status !== "denied" || parent.denyInput === null) {
    throw new WorldError("stale", "Only a denied proposal can be revised.");
  }
  const round = parent.round + 1;
  if (round > MAX_ROUNDS) throw new WorldError("invalid_request", "Too many rounds for one task. Start a new task.");

  const change = await readChange(deps.repos, parent.repo, parent.baseSha, i.headRef);
  const base = { repo: parent.repo, task: parent.task, feedback: [...parent.feedback, parent.denyInput], round };
  return save(
    deps,
    {
      ...base,
      id: (deps.randomId ?? defaultRandomId)(),
      threadId: parent.threadId,
      parentId: parent.id,
      baseSha: change.baseSha,
      headRef: i.headRef,
      headSha: change.headSha,
      linesChanged: change.linesChanged,
      contextHash: contextOf(base, change),
      modelId: i.modelId,
      submitter: getAddress(parent.submitter) as Address,
    },
    change.diff,
  );
}
