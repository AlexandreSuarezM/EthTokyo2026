// ZONE 1 — the end-to-end human-in-the-loop pipeline.
//
//   1. loadUsers            create User objects
//   2. setUserAuth          enroll each user's unique human + apply a permission preset
//   3. loadModel            plug in the model/agent that produces submissions
//   4. runSession           input -> AI submission -> reviewer accept | deny(new input) -> ...
//   5. afterHitlAuth        validator signs + (high tier) live personhood proof -> RECEIPT (no token)
//   6. forensics / track    forensics audits receipts; confirmed mistakes mint the PENALTY token
//                           (escalating, capped, fading score -> stage 1 score / 2 no AI / 3 banned)
import { Wallet, id, TypedDataEncoder, ZeroHash, toUtf8String, decodeBase64 } from 'ethers';
import { SessionContext, hashText } from './context.js';
import { permId, repoId } from './contracts.js';

export const PERMISSIONS = ['REPO_TIER', 'APPROVE_DEPTH', 'SOLO_APPROVE', 'AI_SUBMIT', 'MERGE_PROTECTED', 'GRANT', 'FLAG'];

export class User {
  constructor({ name, wallet, preset }) {
    this.name = name;
    this.wallet = wallet;
    this.preset = preset;
    this.humanId = null;
  }
  get address() { return this.wallet.address; }
}

export class Zone1 {
  constructor({ contracts, provider, admin, operator, forensics, evaluator, prover, log = console.log }) {
    Object.assign(this, contracts); // humans, perms, receipts, ledger, verifier
    this.provider = provider;
    this.admin = admin;
    this.operator = operator;
    this.forensics = forensics;
    this.evaluator = evaluator;
    this.prover = prover;
    this.log = log;
    this.users = new Map();
    this.log_ = []; // off-chain record: sessions, rounds, denials, receipts, actions
  }

  // ---------------------------------------------------------------- 1
  loadUsers(specs) {
    for (const s of specs) {
      const wallet = s.privateKey ? new Wallet(s.privateKey, this.provider) : Wallet.createRandom(this.provider);
      this.users.set(s.name, new User({ name: s.name, wallet, preset: s.preset }));
    }
    return [...this.users.values()];
  }

  // ---------------------------------------------------------------- 2
  async setUserAuth(user) {
    const signal = await this.humans.enrollSignal(user.address);
    const p = await this.prover.prove(signal, user);
    await (await this.humans.connect(user.wallet).enroll(p)).wait();
    user.humanId = await this.humans.humanOf(user.address);
    if (user.preset) await (await this.perms.connect(this.admin).applyPreset(user.humanId, id(user.preset))).wait();
    this.log(`  auth  ${user.name.padEnd(6)} human=${user.humanId.slice(0, 10)}…  preset=${user.preset}`);
    return user.humanId;
  }

  // ---------------------------------------------------------------- 3
  loadModel(model) {
    this.model = model;
    this.modelId = id(model.modelId);
    return this;
  }

  // ---------------------------------------------------------------- 4
  /**
   * @param review async ({ submission, ctx, round }) => { decision: 'accept' } | { decision: 'deny', newInput }
   */
  async runSession({ submitter, reviewer, repo, target, input, review, maxRounds = 5 }) {
    const sessionId = id(`${repo}:${target}:${Date.now()}:${Math.random()}`);
    const session = new SessionContext({ sessionId, repo, target, task: input });

    for (let round = 1; round <= maxRounds; round++) {
      // every model call spends the submitter's AI budget on-chain
      await (await this.perms.connect(this.operator).consumeSubmission(submitter.humanId)).wait();
      const ctx = session.restore();
      const submission = await this.model.submit({ input: round === 1 ? input : session.feedback.at(-1), context: ctx });
      const verdict = await review({ submission, ctx, round });

      if (verdict.decision === 'deny') {
        session.deny(verdict.newInput, submission);
        this.log(`  round ${round}: ${reviewer.name} DENIED  -> "${verdict.newInput}" (context rebuilt)`);
        continue;
      }
      session.accept(submission);
      this.log(`  round ${round}: ${reviewer.name} ACCEPTED (${submission.linesChanged} lines)`);
      const receiptId = await this.afterHitlAuth({ reviewer, submitter, repo, session, ctx, submission, rounds: round - 1 });
      this.log_.push({ type: 'session', sessionId, repo, submitter: submitter.name, reviewer: reviewer.name, history: session.history, receiptId });
      return { sessionId, receiptId, commitHash: hashText(submission.diff) };
    }
    this.log_.push({ type: 'session', sessionId, repo, abandoned: true, history: session.history });
    throw new Error(`session abandoned after ${maxRounds} rounds`);
  }

  // ---------------------------------------------------------------- 5
  async afterHitlAuth({ reviewer, submitter, repo, session, ctx, submission, rounds }) {
    const commitHash = hashText(submission.diff); // production: the git commit/tree hash
    const approval = {
      sessionId: session.sessionId,
      repoId: repoId(repo),
      commitHash,
      contextHash: session.contextHash(ctx, submission),
      modelId: this.modelId,
      submitter: submitter.address,
      linesChanged: submission.linesChanged,
      rounds,
      nonce: BigInt(id(`${session.sessionId}:${reviewer.address}`)),
      deadline: BigInt((await this.provider.getBlock('latest')).timestamp + 3600),
    };

    // (a) key authentication: EIP-712 signature over the exact approval
    const net = await this.provider.getNetwork();
    const domain = { name: 'HITLValidationReceipts', version: '1', chainId: net.chainId, verifyingContract: await this.receipts.getAddress() };
    const signature = await reviewer.wallet.signTypedData(domain, APPROVAL_TYPES, approval);
    const onchainDigest = await this.receipts.approvalDigest(approval);
    if (onchainDigest !== TypedDataEncoder.hash(domain, APPROVAL_TYPES, approval)) throw new Error('EIP-712 mismatch');

    // (b) liveness: above the policy tier, a fresh personhood proof bound to (commit, approver)
    const repoInfo = await this.perms.repo(approval.repoId);
    const policy = await this.perms.policy();
    let live = { root: 0n, nullifier: 0n, proof: Array(8).fill(0n) };
    if (repoInfo.tier >= policy.liveProofTier) {
      live = await this.prover.prove(await this.receipts.liveSignal(commitHash, reviewer.address), reviewer);
      this.log(`  live  personhood proof attached (repo tier ${repoInfo.tier} ≥ ${policy.liveProofTier})`);
    }

    // (c) anyone may relay — here the operator pays gas. Relaying grants no power to mint.
    // attester mode (World ID 4.0 verified in the backend) would fill this; on-chain mode leaves it empty
    const attestation = { proofRef: ZeroHash, presence: false, signature: '0x' };
    const rc = await (await this.receipts.connect(this.operator).validate(approval, signature, live, attestation)).wait();
    const ev = rc.logs.map((l) => { try { return this.receipts.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Validated');
    const receiptId = ev.args.id;
    this.log(`  RECEIPT #${receiptId} recorded for ${reviewer.name} (no token minted) commit=${commitHash.slice(0, 10)}…`);
    this.log_.push({ type: 'receipt', receiptId: receiptId.toString(), reviewer: reviewer.name, commitHash, repo });
    return receiptId;
  }

  // ---------------------------------------------------------------- 6
  /** Keep track: pull accountability events from chain (pull-based, restartable). */
  async track(fromBlock = this._trackedTo ?? 0) {
    const to = await this.provider.getBlockNumber();
    const pulls = [
      [this.receipts, 'Flagged'], [this.receipts, 'Ruled'], [this.receipts, 'Appealed'],
      [this.receipts, 'AppealResolved'], [this.receipts, 'PenaltyIssued'],
      [this.ledger, 'Penalized'], [this.ledger, 'Forgiven'], [this.perms, 'FlagStrike'],
    ];
    const found = [];
    for (const [c, name] of pulls) {
      for (const e of await c.queryFilter(name, fromBlock, to)) {
        found.push({ type: name, block: e.blockNumber, args: e.args.toArray().map(String) });
      }
    }
    found.sort((a, b) => a.block - b.block);
    this.log_.push(...found);
    this._trackedTo = to + 1;
    return found;
  }

  /** Forensics: "was this validation right?" Wrong -> penalty (after due process). */
  async audit(receiptId, correct, evidence, { major = false, forensics = this.forensics } = {}) {
    await (await this.receipts.connect(forensics).audit(receiptId, correct, hashText(evidence), major)).wait();
    this.log(`  AUDIT receipt #${receiptId}: validation ${correct ? 'RIGHT -> cleared, nothing minted' : `WRONG (${major ? 'major' : 'minor'}) -> penalty after due process`}`);
  }

  async flag(flagger, receiptId, evidence) {
    await (await this.receipts.connect(flagger.wallet).flag(receiptId, hashText(evidence))).wait();
    this.log(`  FLAG  receipt #${receiptId} by ${flagger.name}: "${evidence}"`);
  }

  async resolveFlag(receiptId, wrong, { major = false, forensics = this.forensics } = {}) {
    await (await this.receipts.connect(forensics).resolveFlag(receiptId, wrong, major)).wait();
    this.log(`  RULE  receipt #${receiptId} -> ${wrong ? 'WRONG' : 'RIGHT (flagger takes a strike)'}`);
  }

  async appeal(validator, receiptId, reason) {
    await (await this.receipts.connect(validator.wallet).appeal(receiptId, hashText(reason))).wait();
    this.log(`  APPEAL receipt #${receiptId} by ${validator.name}: "${reason}"`);
  }

  async resolveAppeal(reviewer, receiptId, overturn) {
    await (await this.receipts.connect(reviewer).resolveAppeal(receiptId, overturn)).wait();
    this.log(`  APPEAL receipt #${receiptId} -> ${overturn ? 'OVERTURNED' : 'CONFIRMED -> penalty minted'}`);
  }

  async finalize(receiptId) {
    await (await this.receipts.connect(this.operator).finalize(receiptId)).wait();
    this.log(`  FINAL receipt #${receiptId}: appeal window closed -> penalty minted`);
  }

  async forgive(user, points, reason, { evaluator = this.evaluator } = {}) {
    await (await this.ledger.connect(evaluator).forgive(user.humanId, BigInt(points) * 10n ** 18n, hashText(reason))).wait();
    this.log(`  FORGIVE ${user.name}: -${points} points ("${reason}")`);
  }

  async standing(user) {
    const score = Number((await this.ledger.scoreOf(user.humanId)) / 10n ** 15n) / 1000;
    const stage = Number(await this.ledger.stageOf(user.humanId));
    const penalties = Number(await this.ledger.balanceOf(user.address));
    return { score: Math.floor(score * 10) / 10, stage, stageName: STAGES[stage], penalties };
  }

  async penaltyMetadata(tokenId) {
    const uri = await this.ledger.tokenURI(tokenId);
    return JSON.parse(toUtf8String(decodeBase64(uri.split(',')[1])));
  }

  async permissionsOf(user) {
    const out = {};
    for (const p of PERMISSIONS) out[p] = Number(await this.perms.activeValue(user.humanId, permId(p)));
    return out;
  }
}

export const STAGES = ['clean', 'losing score (published)', 'no AI access', 'banned'];

export const APPROVAL_TYPES = {
  HumanApproval: [
    { name: 'sessionId', type: 'bytes32' },
    { name: 'repoId', type: 'bytes32' },
    { name: 'commitHash', type: 'bytes32' },
    { name: 'contextHash', type: 'bytes32' },
    { name: 'modelId', type: 'bytes32' },
    { name: 'submitter', type: 'address' },
    { name: 'linesChanged', type: 'uint32' },
    { name: 'rounds', type: 'uint16' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

