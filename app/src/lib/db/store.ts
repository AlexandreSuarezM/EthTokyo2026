import "server-only";
import { normalizeNullifier } from "@/lib/world/nullifier";

export { normalizeNullifier };

/**
 * Storage for World ID state: nullifiers, sessions, pending enrollments, consumed approvals,
 * and the approval flow: proposals, pending approvals, recorded receipts.
 * Every "record once" operation is a single INSERT ... ON CONFLICT DO NOTHING RETURNING,
 * so uniqueness is enforced by the database, atomically, never by a read-then-write.
 */

// 1 = ORB (Proof of Human), 2 = SELFIE, 3 = SIMULATED (demo, no World proof); same values as HumanRegistry
export type CredentialLevel = 1 | 2 | 3;

export type SessionRecord = {
  humanId: `0x${string}`;
  sessionId: string;
  account: `0x${string}`;
  credentialLevel: CredentialLevel;
  /** Enrollment nullifier (decimal), unique: one session row per human. */
  enrollNullifier: string;
  /** Selfie Check z-score at enrollment; null for Proof of Human. */
  sybilScore: number | null;
  createdAt: number;
};

/** State between /api/enroll/start and /api/enroll/complete. Single use, short-lived. */
export type PendingEnrollment = {
  id: string;
  humanId: `0x${string}`;
  enrollNullifier: string;
  account: `0x${string}`;
  credentialLevel: CredentialLevel;
  sybilScore: number | null;
  expiresAt: number;
};

/** One AI proposal shown to a validator. A deny closes it; the next round is a new proposal. */
export type Proposal = {
  id: string;
  /** Id of round 1 of this task: the HumanApproval.sessionId on-chain. */
  threadId: string;
  /** The denied proposal this one revises; null in round 1. Unique: one revision per deny. */
  parentId: string | null;
  repo: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  linesChanged: number;
  /** keccak256 of exactly what the validator was shown (see proposals.ts contextOf). */
  contextHash: `0x${string}`;
  task: string;
  /** Validator input from every earlier deny, oldest first. */
  feedback: string[];
  round: number;
  modelId: string;
  submitter: `0x${string}`;
  status: "open" | "denied";
  denyInput: string | null;
  createdAt: number;
};

/** A HumanApproval built by the server, waiting for the validator's signature and World ID proof. */
export type PendingApproval = {
  id: string;
  proposalId: string;
  /** The HumanApproval message as JSON (uint256 values as decimal strings). */
  message: string;
  digest: `0x${string}`;
  expiresAt: number;
};

/** A receipt recorded on-chain for one consumed approval key. */
export type ApprovalRecord = {
  approvalKey: string;
  receiptId: string;
  txHash: `0x${string}`;
  proposalId: string;
  humanId: `0x${string}`;
  proofRef: `0x${string}`;
  /** The World ID result that was verified, kept off-chain for audit (proofRef = its hash). */
  worldResult: string;
  createdAt: number;
};

/** Demo only: one fake-AI answer. `verdict` and `salt` never leave the server before the judge runs. */
export type DemoAnswer = { id: string; code: string; variant: string; verdict: "right" | "wrong"; salt: `0x${string}`; createdAt: number };

/** Demo only: the judge's ruling on one receipt (claimed once, then completed). */
export type DemoJudgment = {
  receiptId: string;
  verdict: "right" | "wrong";
  tokenId: string | null;
  txHash: `0x${string}` | null;
  createdAt: number;
};

export interface Store {
  /** Records (action, nullifier) once. Returns false if it was already used. */
  recordNullifier(action: string, nullifier: string | bigint, humanId?: `0x${string}`): Promise<boolean>;
  /**
   * Stores the enrollment session in one INSERT. Returns false if the human, the session_id or the
   * enrollment nullifier is already stored.
   */
  saveSession(rec: Omit<SessionRecord, "createdAt">): Promise<boolean>;
  savePending(p: PendingEnrollment): Promise<boolean>;
  getPending(id: string): Promise<PendingEnrollment | null>;
  /** Atomically removes and returns a pending enrollment: only one caller ever gets it. */
  takePending(id: string): Promise<PendingEnrollment | null>;
  sessionOfHuman(humanId: `0x${string}`): Promise<SessionRecord | null>;
  humanOfSession(sessionId: string): Promise<SessionRecord | null>;
  /** Atomically records an approval key; returns false if it was already used (single use). */
  consumeApproval(key: string): Promise<boolean>;
  /** Frees an approval key. Only for failures where we know no transaction was sent. */
  releaseApproval(key: string): Promise<void>;
  /** Returns false if the id exists or the parent already has a revision. */
  saveProposal(p: Omit<Proposal, "status" | "denyInput" | "createdAt">): Promise<boolean>;
  getProposal(id: string): Promise<Proposal | null>;
  /** Atomically closes an open proposal with the validator's input; null if it wasn't open. */
  denyProposal(id: string, input: string): Promise<Proposal | null>;
  savePendingApproval(a: PendingApproval): Promise<boolean>;
  getPendingApproval(id: string): Promise<PendingApproval | null>;
  /** Atomically removes and returns a pending approval: only one caller ever gets it. */
  takePendingApproval(id: string): Promise<PendingApproval | null>;
  saveReceipt(r: Omit<ApprovalRecord, "createdAt">): Promise<boolean>;
  receiptOf(approvalKey: string): Promise<ApprovalRecord | null>;
  receiptById(receiptId: string): Promise<ApprovalRecord | null>;
  receiptsOfHuman(humanId: `0x${string}`): Promise<ApprovalRecord[]>;
  saveDemoAnswer(a: Omit<DemoAnswer, "createdAt">): Promise<boolean>;
  getDemoAnswer(id: string): Promise<DemoAnswer | null>;
  /** Claims the judgment of a receipt once; false if it was already claimed. */
  claimJudgment(receiptId: string, verdict: "right" | "wrong"): Promise<boolean>;
  completeJudgment(receiptId: string, tokenId: string, txHash: `0x${string}`): Promise<void>;
  releaseJudgment(receiptId: string): Promise<void>;
  getJudgment(receiptId: string): Promise<DemoJudgment | null>;
  /** Demo: the judge's lifts, recorded when sent (free-tier RPCs can't scan event logs). */
  recordLift(humanId: `0x${string}`, txHash: `0x${string}`): Promise<void>;
  liftsOf(humanId: `0x${string}`): Promise<{ at: number; txHash: `0x${string}` }[]>;
  close(): Promise<void>;
}

/** Minimal driver: "?" placeholders, returns rows. */
export interface Driver {
  dialect: "sqlite" | "postgres";
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

const SCHEMA = [
  // nullifier: 256-bit value stored as a decimal string (hex is normalised first)
  `CREATE TABLE IF NOT EXISTS nullifiers (
     action TEXT NOT NULL,
     nullifier TEXT NOT NULL,
     human_id TEXT,
     created_at BIGINT NOT NULL,
     PRIMARY KEY (action, nullifier))`,
  `CREATE TABLE IF NOT EXISTS sessions (
     human_id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL UNIQUE,
     account TEXT NOT NULL,
     credential_level INTEGER NOT NULL,
     enroll_nullifier TEXT NOT NULL UNIQUE,
     sybil_score DOUBLE PRECISION,
     created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pending_enrollments (
     id TEXT PRIMARY KEY,
     human_id TEXT NOT NULL,
     enroll_nullifier TEXT NOT NULL,
     account TEXT NOT NULL,
     credential_level INTEGER NOT NULL,
     sybil_score DOUBLE PRECISION,
     expires_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS consumed_approvals (
     approval_key TEXT PRIMARY KEY,
     created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS proposals (
     id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     parent_id TEXT UNIQUE,
     repo TEXT NOT NULL,
     base_sha TEXT NOT NULL,
     head_ref TEXT NOT NULL,
     head_sha TEXT NOT NULL,
     lines_changed INTEGER NOT NULL,
     context_hash TEXT NOT NULL,
     task TEXT NOT NULL,
     feedback TEXT NOT NULL,
     round INTEGER NOT NULL,
     model_id TEXT NOT NULL,
     submitter TEXT NOT NULL,
     status TEXT NOT NULL,
     deny_input TEXT,
     created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pending_approvals (
     id TEXT PRIMARY KEY,
     proposal_id TEXT NOT NULL,
     message TEXT NOT NULL,
     digest TEXT NOT NULL,
     expires_at BIGINT NOT NULL)`,
  // One row per consumed approval key: one approval = one receipt.
  `CREATE TABLE IF NOT EXISTS receipts (
     approval_key TEXT PRIMARY KEY,
     receipt_id TEXT NOT NULL UNIQUE,
     tx_hash TEXT NOT NULL,
     proposal_id TEXT NOT NULL,
     human_id TEXT NOT NULL,
     proof_ref TEXT NOT NULL,
     world_result TEXT NOT NULL,
     created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS demo_answers (
     id TEXT PRIMARY KEY,
     code TEXT NOT NULL,
     variant TEXT NOT NULL,
     verdict TEXT NOT NULL,
     salt TEXT NOT NULL,
     created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS demo_lifts (
     tx_hash TEXT PRIMARY KEY,
     human_id TEXT NOT NULL,
     created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS demo_judgments (
     receipt_id TEXT PRIMARY KEY,
     verdict TEXT NOT NULL,
     token_id TEXT,
     tx_hash TEXT,
     created_at BIGINT NOT NULL)`,
];

const now = () => Math.floor(Date.now() / 1000);

function toSession(row: Record<string, unknown> | undefined): SessionRecord | null {
  if (!row) return null;
  return {
    humanId: String(row.human_id) as `0x${string}`,
    sessionId: String(row.session_id),
    account: String(row.account) as `0x${string}`,
    credentialLevel: Number(row.credential_level) as CredentialLevel,
    enrollNullifier: String(row.enroll_nullifier),
    sybilScore: row.sybil_score === null || row.sybil_score === undefined ? null : Number(row.sybil_score),
    createdAt: Number(row.created_at),
  };
}

function toPending(row: Record<string, unknown> | undefined): PendingEnrollment | null {
  if (!row) return null;
  return {
    id: String(row.id),
    humanId: String(row.human_id) as `0x${string}`,
    enrollNullifier: String(row.enroll_nullifier),
    account: String(row.account) as `0x${string}`,
    credentialLevel: Number(row.credential_level) as CredentialLevel,
    sybilScore: row.sybil_score === null || row.sybil_score === undefined ? null : Number(row.sybil_score),
    expiresAt: Number(row.expires_at),
  };
}

const nullable = (v: unknown) => (v === null || v === undefined ? null : String(v));

function toProposal(row: Record<string, unknown> | undefined): Proposal | null {
  if (!row) return null;
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    parentId: nullable(row.parent_id),
    repo: String(row.repo),
    baseSha: String(row.base_sha),
    headRef: String(row.head_ref),
    headSha: String(row.head_sha),
    linesChanged: Number(row.lines_changed),
    contextHash: String(row.context_hash) as `0x${string}`,
    task: String(row.task),
    feedback: JSON.parse(String(row.feedback)) as string[],
    round: Number(row.round),
    modelId: String(row.model_id),
    submitter: String(row.submitter) as `0x${string}`,
    status: String(row.status) as Proposal["status"],
    denyInput: nullable(row.deny_input),
    createdAt: Number(row.created_at),
  };
}

function toPendingApproval(row: Record<string, unknown> | undefined): PendingApproval | null {
  if (!row) return null;
  return {
    id: String(row.id),
    proposalId: String(row.proposal_id),
    message: String(row.message),
    digest: String(row.digest) as `0x${string}`,
    expiresAt: Number(row.expires_at),
  };
}

function toApprovalRecord(row: Record<string, unknown> | undefined): ApprovalRecord | null {
  if (!row) return null;
  return {
    approvalKey: String(row.approval_key),
    receiptId: String(row.receipt_id),
    txHash: String(row.tx_hash) as `0x${string}`,
    proposalId: String(row.proposal_id),
    humanId: String(row.human_id) as `0x${string}`,
    proofRef: String(row.proof_ref) as `0x${string}`,
    worldResult: String(row.world_result),
    createdAt: Number(row.created_at),
  };
}

export async function createStore(driver: Driver): Promise<Store> {
  for (const stmt of SCHEMA) await driver.query(stmt, []);

  const insertOnce = async (sql: string, params: unknown[]) =>
    (await driver.query(`${sql} ON CONFLICT DO NOTHING RETURNING 1 AS inserted`, params)).length === 1;

  return {
    recordNullifier: async (action, nullifier, humanId) =>
      insertOnce("INSERT INTO nullifiers (action, nullifier, human_id, created_at) VALUES (?, ?, ?, ?)", [
        action,
        normalizeNullifier(nullifier),
        humanId?.toLowerCase() ?? null,
        now(),
      ]),

    saveSession: async (rec) =>
      insertOnce(
        `INSERT INTO sessions (human_id, session_id, account, credential_level, enroll_nullifier, sybil_score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          rec.humanId.toLowerCase(),
          rec.sessionId,
          rec.account.toLowerCase(),
          rec.credentialLevel,
          normalizeNullifier(rec.enrollNullifier),
          rec.sybilScore,
          now(),
        ],
      ),

    savePending: async (p) =>
      insertOnce(
        `INSERT INTO pending_enrollments (id, human_id, enroll_nullifier, account, credential_level, sybil_score, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [p.id, p.humanId.toLowerCase(), normalizeNullifier(p.enrollNullifier), p.account.toLowerCase(), p.credentialLevel, p.sybilScore, p.expiresAt],
      ),

    getPending: async (id) => toPending((await driver.query("SELECT * FROM pending_enrollments WHERE id = ?", [id]))[0]),

    takePending: async (id) =>
      toPending((await driver.query("DELETE FROM pending_enrollments WHERE id = ? RETURNING *", [id]))[0]),

    sessionOfHuman: async (humanId) =>
      toSession((await driver.query("SELECT * FROM sessions WHERE human_id = ?", [humanId.toLowerCase()]))[0]),

    humanOfSession: async (sessionId) =>
      toSession((await driver.query("SELECT * FROM sessions WHERE session_id = ?", [sessionId]))[0]),

    consumeApproval: async (key) => {
      if (!key) throw new TypeError("approval key is required");
      return insertOnce("INSERT INTO consumed_approvals (approval_key, created_at) VALUES (?, ?)", [key, now()]);
    },

    releaseApproval: async (key) => {
      await driver.query("DELETE FROM consumed_approvals WHERE approval_key = ?", [key]);
    },

    saveProposal: async (p) =>
      insertOnce(
        `INSERT INTO proposals (id, thread_id, parent_id, repo, base_sha, head_ref, head_sha, lines_changed, context_hash,
           task, feedback, round, model_id, submitter, status, deny_input, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?)`,
        [
          p.id,
          p.threadId,
          p.parentId,
          p.repo,
          p.baseSha,
          p.headRef,
          p.headSha,
          p.linesChanged,
          p.contextHash.toLowerCase(),
          p.task,
          JSON.stringify(p.feedback),
          p.round,
          p.modelId,
          p.submitter.toLowerCase(),
          now(),
        ],
      ),

    getProposal: async (id) => toProposal((await driver.query("SELECT * FROM proposals WHERE id = ?", [id]))[0]),

    denyProposal: async (id, input) =>
      toProposal(
        (await driver.query("UPDATE proposals SET status = 'denied', deny_input = ? WHERE id = ? AND status = 'open' RETURNING *", [input, id]))[0],
      ),

    savePendingApproval: async (a) =>
      insertOnce("INSERT INTO pending_approvals (id, proposal_id, message, digest, expires_at) VALUES (?, ?, ?, ?, ?)", [
        a.id,
        a.proposalId,
        a.message,
        a.digest.toLowerCase(),
        a.expiresAt,
      ]),

    getPendingApproval: async (id) =>
      toPendingApproval((await driver.query("SELECT * FROM pending_approvals WHERE id = ?", [id]))[0]),

    takePendingApproval: async (id) =>
      toPendingApproval((await driver.query("DELETE FROM pending_approvals WHERE id = ? RETURNING *", [id]))[0]),

    saveReceipt: async (r) =>
      insertOnce(
        `INSERT INTO receipts (approval_key, receipt_id, tx_hash, proposal_id, human_id, proof_ref, world_result, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.approvalKey, r.receiptId, r.txHash, r.proposalId, r.humanId.toLowerCase(), r.proofRef, r.worldResult, now()],
      ),

    receiptOf: async (key) => toApprovalRecord((await driver.query("SELECT * FROM receipts WHERE approval_key = ?", [key]))[0]),

    receiptById: async (id) => toApprovalRecord((await driver.query("SELECT * FROM receipts WHERE receipt_id = ?", [id]))[0]),

    receiptsOfHuman: async (humanId) =>
      (await driver.query("SELECT * FROM receipts WHERE human_id = ? ORDER BY created_at DESC", [humanId.toLowerCase()])).map(
        (r) => toApprovalRecord(r)!,
      ),

    saveDemoAnswer: async (a) =>
      insertOnce("INSERT INTO demo_answers (id, code, variant, verdict, salt, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
        a.id,
        a.code,
        a.variant,
        a.verdict,
        a.salt,
        now(),
      ]),

    getDemoAnswer: async (id) => {
      const r = (await driver.query("SELECT * FROM demo_answers WHERE id = ?", [id]))[0];
      if (!r) return null;
      return {
        id: String(r.id),
        code: String(r.code),
        variant: String(r.variant),
        verdict: String(r.verdict) as "right" | "wrong",
        salt: String(r.salt) as `0x${string}`,
        createdAt: Number(r.created_at),
      };
    },

    claimJudgment: async (receiptId, verdict) =>
      insertOnce("INSERT INTO demo_judgments (receipt_id, verdict, token_id, tx_hash, created_at) VALUES (?, ?, NULL, NULL, ?)", [
        receiptId,
        verdict,
        now(),
      ]),

    completeJudgment: async (receiptId, tokenId, txHash) => {
      await driver.query("UPDATE demo_judgments SET token_id = ?, tx_hash = ? WHERE receipt_id = ?", [tokenId, txHash, receiptId]);
    },

    releaseJudgment: async (receiptId) => {
      await driver.query("DELETE FROM demo_judgments WHERE receipt_id = ?", [receiptId]);
    },

    recordLift: async (humanId, txHash) => {
      await insertOnce("INSERT INTO demo_lifts (tx_hash, human_id, created_at) VALUES (?, ?, ?)", [txHash, humanId.toLowerCase(), now()]);
    },

    liftsOf: async (humanId) =>
      (await driver.query("SELECT * FROM demo_lifts WHERE human_id = ? ORDER BY created_at", [humanId.toLowerCase()])).map((r) => ({
        at: Number(r.created_at),
        txHash: String(r.tx_hash) as `0x${string}`,
      })),

    getJudgment: async (receiptId) => {
      const r = (await driver.query("SELECT * FROM demo_judgments WHERE receipt_id = ?", [receiptId]))[0];
      if (!r) return null;
      return {
        receiptId: String(r.receipt_id),
        verdict: String(r.verdict) as "right" | "wrong",
        tokenId: r.token_id === null || r.token_id === undefined ? null : String(r.token_id),
        txHash: r.tx_hash === null || r.tx_hash === undefined ? null : (String(r.tx_hash) as `0x${string}`),
        createdAt: Number(r.created_at),
      };
    },

    close: () => driver.close(),
  };
}

/** Rewrites "?" placeholders to Postgres "$1, $2, ...". The schema and queries contain no literal "?". */
export function toPostgresPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
