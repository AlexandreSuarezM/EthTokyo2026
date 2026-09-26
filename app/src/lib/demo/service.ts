import "server-only";
import { getAddress, isAddress, keccak256, stringToHex, zeroHash, type Address, type Hash, type Hex } from "viem";
import { z } from "zod";
import type { Store } from "@/lib/db/store";
import { DEMO_MODEL, DEMO_REPO, DEMO_TASK, askAi, commitmentOf, secureCoin, type Coin } from "@/lib/demo/ai";
import { prepareApproval, type ApproveDeps, type PrepareResult } from "@/lib/world/approve";
import { WorldError } from "@/lib/world/errors";
import { denyProposal, openProposal, reviseProposal, type ProposalView } from "@/lib/world/proposals";

/**
 * Single-user demo (docs/DEMO_PLAN.md). The user (validator) asks the fake AI, rejects (new round,
 * nothing on-chain) or approves (CC-10: receipt on-chain, no token). The judge (the relayer key, a demo
 * trust assumption) reveals the sealed verdict, mints a penalty token when approved code was wrong, and
 * may lift a restriction early. It can never lift a ban (3 tokens).
 */

export const STAGE_RESTRICTED = 2;
export const STAGE_BANNED = 3;

/** What the server reads from the chain. */
export type ChainReads = {
  humanOf(account: Address): Promise<Hex>;
  levelOf(human: Hex): Promise<number>;
  stageOf(human: Hex): Promise<number>;
  scoreOf(human: Hex): Promise<bigint>;
  penaltyCount(human: Hex): Promise<number>;
  isBannedForever(human: Hex): Promise<boolean>;
  /** Seconds until the restriction ends by itself (score under stage2At); 0 if not restricted. */
  secondsRestricted(human: Hex): Promise<number>;
  hasValidatorPreset(human: Hex): Promise<boolean>;
  /** The contextHash recorded on-chain in receipt `id`. */
  receiptContextHash(id: bigint): Promise<Hex>;
  penalties(human: Hex): Promise<{ tokenId: string; receiptId: string; mintedAt: number; txHash: Hash }[]>;
  lifts(human: Hex): Promise<{ at: number; txHash: Hash }[]>;
  /** ChallengeRewards (null when not deployed). */
  rewards(human: Hex): Promise<Rewards | null>;
};

/** Reward points and the prize pool, as the page shows them. */
export type Rewards = {
  points: number;
  threshold: number;
  cooldown: number;
  secondsUntilNextPoint: number;
  optedIn: boolean;
  claimed: boolean;
  optedInCount: number;
  deadline: number;
  poolWei: string;
  shareWei: string;
  contract: Address;
};

/** Transactions sent by server keys. */
export type ChainWrites = {
  /** Judge (relayer, ORACLE_ROLE): ValidationReceipts.oraclePenalize. */
  penalize(receiptId: bigint, evidenceHash: Hex): Promise<{ tokenId: string; txHash: Hash }>;
  /** Judge (relayer, JUDGE_ROLE): PenaltyLedger.judgeLift. */
  lift(human: Hex, reasonHash: Hex): Promise<Hash>;
  /** Admin (deployer): PermissionRegistry.applyPreset(human, "validator"). */
  grantValidator(human: Hex): Promise<Hash>;
  /** Judge: ChallengeRewards.award. `awarded: false` when the cooldown is still running. Null = no rewards contract. */
  award?(human: Hex, receiptId: bigint): Promise<{ awarded: true; txHash: Hash } | { awarded: false; reason: string }>;
  /** Judge: ChallengeRewards.slash (all points). */
  slash?(human: Hex, reasonHash: Hex): Promise<Hash>;
};

export type DemoDeps = {
  store: Store;
  approve: ApproveDeps; // its `repos` must serve DEMO_REPO (withDemoRepo)
  reads: ChainReads;
  writes: ChainWrites;
  coin?: Coin;
};

const address = z.string().refine((v) => isAddress(v, { strict: false })).transform((v) => getAddress(v));
const ID = /^[0-9a-f]{64}$/;
const askBody = z.strictObject({ account: address });
const rejectBody = z.strictObject({ proposalId: z.string().regex(ID) });
const judgeBody = z.strictObject({ receiptId: z.string().regex(/^[0-9]{1,20}$/) });
const liftBody = z.strictObject({ account: address, reason: z.string().trim().min(3).max(500) });

function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new WorldError("invalid_request", "The request is malformed.");
  return parsed.data;
}

async function onChain<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch {
    throw new WorldError("verification_unavailable", "Could not read the chain. Try again.");
  }
}

/** The enrolled human behind a wallet, and a check that they may still use the AI (fail closed). */
async function activeHuman(deps: DemoDeps, account: Address): Promise<Hex> {
  const human = await onChain(() => deps.reads.humanOf(account));
  if (human === zeroHash) throw new WorldError("not_enrolled", "Enroll first.");
  const stage = await onChain(() => deps.reads.stageOf(human));
  if (stage >= STAGE_BANNED) throw new WorldError("ineligible", "Banned: repo access closed.");
  if (stage >= STAGE_RESTRICTED) throw new WorldError("ineligible", "Restricted: wait for the countdown or the judge.");
  return human;
}

/** Only the code goes to the page: never the verdict, the variant name or the salt. */
export type AnswerView = Pick<ProposalView, "id" | "round" | "diff" | "task" | "linesChanged" | "commitHash"> & { code: string };
const toView = (p: ProposalView): AnswerView => ({
  id: p.id,
  round: p.round,
  diff: p.diff,
  code: p.diff,
  task: p.task,
  linesChanged: p.linesChanged,
  commitHash: p.commitHash,
});

/** "Ask the AI": round 1 of a new task. */
export async function ask(deps: DemoDeps, body: unknown): Promise<AnswerView> {
  const { account } = parse(askBody, body);
  await activeHuman(deps, account);
  const answer = await askAi(deps.store, deps.coin ?? secureCoin);
  const p = await openProposal(
    { store: deps.store, repos: deps.approve.repos },
    { repo: DEMO_REPO, baseRef: "base", headRef: answer.id, task: DEMO_TASK, modelId: DEMO_MODEL, submitter: account },
  );
  return toView(p);
}

/** Reject = a new answer in the next round. Nothing on-chain, never a token. */
export async function reject(deps: DemoDeps, body: unknown): Promise<AnswerView> {
  const { proposalId } = parse(rejectBody, body);
  const denied = await denyProposal({ store: deps.store, repos: deps.approve.repos }, { proposalId, input: "Rejected by the validator" });
  const answer = await askAi(deps.store, deps.coin ?? secureCoin);
  const p = await reviseProposal(
    { store: deps.store, repos: deps.approve.repos },
    { parentId: denied.next.parentId, headRef: answer.id, modelId: DEMO_MODEL },
  );
  return toView(p);
}

/** Approve, step 1: CC-10 prepare, refused while restricted or banned. */
export async function prepare(deps: DemoDeps, body: unknown): Promise<PrepareResult & { sessionId: string | null }> {
  const { proposalId } = parse(rejectBody, body);
  const p = await deps.store.getProposal(proposalId);
  if (!p) throw new WorldError("invalid_request", "Unknown proposal.");
  const human = await activeHuman(deps, getAddress(p.submitter));
  const result = await prepareApproval(deps.approve, { proposalId });
  // Real World ID mode needs the user's own session id for proveSession; simulated mode ignores it.
  const session = deps.approve.mode === "simulated" ? null : await deps.store.sessionOfHuman(human);
  return { ...result, sessionId: session?.sessionId ?? null };
}

export type JudgeResult = {
  receiptId: string;
  verdict: "right" | "wrong";
  /** Revealed only now, after the receipt exists. */
  salt: Hex;
  commitment: Hex;
  fingerprintMatches: boolean;
  tokenId: string | null;
  txHash: Hash | null;
  alreadyJudged: boolean;
  /** Right: +1 point, or why not (cooldown). Wrong: all points slashed. Null without a rewards contract. */
  reward: null | { awarded: boolean; note: string; txHash: Hash | null };
};

/**
 * The judge rules on one receipt, once: reveals verdict + salt, checks the fingerprint against the
 * contextHash recorded on-chain, and mints a penalty token when approved code was wrong.
 */
export async function judge(deps: DemoDeps, body: unknown): Promise<JudgeResult> {
  const { receiptId } = parse(judgeBody, body);
  const rec = await deps.store.receiptById(receiptId);
  if (!rec) throw new WorldError("invalid_request", "Unknown receipt.");
  const proposal = await deps.store.getProposal(rec.proposalId);
  const answer = proposal ? await deps.store.getDemoAnswer(proposal.headRef) : null;
  if (!proposal || !answer) throw new WorldError("invalid_request", "This receipt is not a demo answer.");

  const commitment = commitmentOf(answer.code, answer.verdict, answer.salt);
  const onChainContext = await onChain(() => deps.reads.receiptContextHash(BigInt(receiptId)));
  const fingerprintMatches = commitment === proposal.contextHash && commitment === onChainContext;
  if (!fingerprintMatches) throw new WorldError("rejected", "The fingerprint does not match the receipt. Refusing to judge.");

  const base = { receiptId, verdict: answer.verdict, salt: answer.salt, commitment, fingerprintMatches };
  if (!(await deps.store.claimJudgment(receiptId, answer.verdict))) {
    const j = await deps.store.getJudgment(receiptId);
    return { ...base, tokenId: j?.tokenId ?? null, txHash: j?.txHash ?? null, alreadyJudged: true, reward: null };
  }
  const human = rec.humanId;
  if (answer.verdict === "right") {
    let reward: JudgeResult["reward"] = null;
    if (deps.writes.award) {
      try {
        const r = await deps.writes.award(human, BigInt(receiptId));
        reward = r.awarded ? { awarded: true, note: "+1 reward point", txHash: r.txHash } : { awarded: false, note: r.reason, txHash: null };
      } catch {
        reward = { awarded: false, note: "Reward point not recorded (transaction failed).", txHash: null };
      }
    }
    return { ...base, tokenId: null, txHash: null, alreadyJudged: false, reward };
  }

  try {
    // Evidence = the revealed commitment: anyone can recompute it from code, verdict and salt.
    const { tokenId, txHash } = await deps.writes.penalize(BigInt(receiptId), commitment);
    await deps.store.completeJudgment(receiptId, tokenId, txHash);
    let reward: JudgeResult["reward"] = null;
    if (deps.writes.slash) {
      try {
        reward = { awarded: false, note: "All reward points slashed", txHash: await deps.writes.slash(human, commitment) };
      } catch {
        reward = { awarded: false, note: "Point slash failed (penalty token still minted).", txHash: null };
      }
    }
    return { ...base, tokenId, txHash, alreadyJudged: false, reward };
  } catch (e) {
    await deps.store.releaseJudgment(receiptId); // nothing minted: the judge may run again
    if (e instanceof WorldError) throw e;
    throw new WorldError("verification_unavailable", "The penalty transaction failed. Run the judge again.");
  }
}

/** The judge lifts a restriction early (score -> 0). The token stays. A ban can't be lifted. */
export async function lift(deps: DemoDeps, body: unknown): Promise<{ txHash: Hash }> {
  const { account, reason } = parse(liftBody, body);
  const human = await onChain(() => deps.reads.humanOf(account));
  if (human === zeroHash) throw new WorldError("not_enrolled", "Not enrolled.");
  if (await onChain(() => deps.reads.isBannedForever(human))) throw new WorldError("ineligible", "A ban can't be lifted.");
  if ((await onChain(() => deps.reads.stageOf(human))) < STAGE_RESTRICTED) throw new WorldError("stale", "Nothing to lift.");
  let txHash: Hash;
  try {
    txHash = await deps.writes.lift(human, keccak256(stringToHex(reason)));
  } catch {
    throw new WorldError("verification_unavailable", "The lift transaction failed. Try again.");
  }
  await deps.store.recordLift(human, txHash);
  return { txHash };
}

/** After enrollment: the admin grants the "validator" preset once (demo trust assumption). */
export async function onboard(deps: DemoDeps, body: unknown): Promise<{ granted: boolean; txHash: Hash | null }> {
  const { account } = parse(askBody, body);
  const human = await onChain(() => deps.reads.humanOf(account));
  if (human === zeroHash) throw new WorldError("not_enrolled", "Send enrollAttested from your wallet first.");
  if (await onChain(() => deps.reads.hasValidatorPreset(human))) return { granted: false, txHash: null };
  try {
    return { granted: true, txHash: await deps.writes.grantValidator(human) };
  } catch {
    throw new WorldError("verification_unavailable", "Could not grant the validator permissions. Try again.");
  }
}

export type Standing = {
  enrolled: boolean;
  humanId: Hex | null;
  level: number;
  status: "none" | "active" | "restricted" | "banned";
  stage: number;
  score: string;
  tokens: number;
  restrictedSeconds: number;
  penalties: { tokenId: string; receiptId: string; mintedAt: number; txHash: Hash; lifted: boolean }[];
  receipts: { receiptId: string; txHash: Hash; createdAt: number; judged: null | { verdict: "right" | "wrong"; tokenId: string | null; txHash: Hash | null } }[];
  rewards: Rewards | null;
};

/** "Your standing": read from the chain (score, stage, tokens) plus our receipts and the judge's rulings. */
export async function standing(deps: DemoDeps, account: string): Promise<Standing> {
  if (!isAddress(account, { strict: false })) throw new WorldError("invalid_request", "Bad address.");
  const human = await onChain(() => deps.reads.humanOf(getAddress(account)));
  if (human === zeroHash) {
    return {
      enrolled: false,
      humanId: null,
      level: 0,
      status: "none",
      stage: 0,
      score: "0",
      tokens: 0,
      restrictedSeconds: 0,
      penalties: [],
      receipts: [],
      rewards: null,
    };
  }
  const [level, stage, score, tokens, banned, restrictedSeconds, penalties, lifts, rewards] = await onChain(() =>
    Promise.all([
      deps.reads.levelOf(human),
      deps.reads.stageOf(human),
      deps.reads.scoreOf(human),
      deps.reads.penaltyCount(human),
      deps.reads.isBannedForever(human),
      deps.reads.secondsRestricted(human),
      deps.reads.penalties(human),
      deps.reads.lifts(human),
      deps.reads.rewards(human),
    ]),
  );
  const recs = await deps.store.receiptsOfHuman(human);
  const receipts = await Promise.all(
    recs.map(async (r) => {
      const j = await deps.store.getJudgment(r.receiptId);
      return { receiptId: r.receiptId, txHash: r.txHash, createdAt: r.createdAt, judged: j ? { verdict: j.verdict, tokenId: j.tokenId, txHash: j.txHash } : null };
    }),
  );
  return {
    enrolled: true,
    humanId: human,
    level,
    status: banned || stage >= STAGE_BANNED ? "banned" : stage >= STAGE_RESTRICTED ? "restricted" : "active",
    stage,
    score: score.toString(),
    tokens,
    restrictedSeconds: banned ? 0 : restrictedSeconds,
    // a token's restriction was lifted early when the judge lifted after it was minted
    // a token's restriction was lifted early if the judge lifted before the next token was minted
    penalties: penalties
      .sort((a, b) => a.mintedAt - b.mintedAt)
      .map((p, i, all) => ({ ...p, lifted: lifts.some((l) => l.at >= p.mintedAt && (i + 1 >= all.length || l.at < all[i + 1].mintedAt)) })),
    receipts,
    rewards,
  };
}
