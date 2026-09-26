import "server-only";
import { normalizeNullifier } from "@/lib/world/nullifier";

export { normalizeNullifier };

/**
 * Storage for World ID state: nullifiers, sessions, pending enrollments, consumed approvals.
 * Every "record once" operation is a single INSERT ... ON CONFLICT DO NOTHING RETURNING,
 * so uniqueness is enforced by the database, atomically, never by a read-then-write.
 */

export type CredentialLevel = 1 | 2; // 1 = ORB (Proof of Human), 2 = SELFIE; same values as HumanRegistry

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

    close: () => driver.close(),
  };
}

/** Rewrites "?" placeholders to Postgres "$1, $2, ...". The schema and queries contain no literal "?". */
export function toPostgresPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
