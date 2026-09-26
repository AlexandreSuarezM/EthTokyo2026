import "server-only";

/**
 * Storage for World ID state: nullifiers, sessions, consumed approvals.
 * Every "record once" operation is a single INSERT ... ON CONFLICT DO NOTHING RETURNING,
 * so uniqueness is enforced by the database, atomically, never by a read-then-write.
 */

export type CredentialLevel = 1 | 2; // 1 = ORB (Proof of Human), 2 = SELFIE; same values as HumanRegistry

export type SessionRecord = {
  humanId: `0x${string}`;
  sessionId: string;
  account: `0x${string}`;
  credentialLevel: CredentialLevel;
  createdAt: number;
};

export interface Store {
  /** Records (action, nullifier) once. Returns false if it was already used. */
  recordNullifier(action: string, nullifier: string | bigint, humanId?: `0x${string}`): Promise<boolean>;
  /** Stores the enrollment session. Returns false if the human or the session is already stored. */
  saveSession(rec: Omit<SessionRecord, "createdAt">): Promise<boolean>;
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
     created_at BIGINT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS consumed_approvals (
     approval_key TEXT PRIMARY KEY,
     created_at BIGINT NOT NULL)`,
];

/** Canonical decimal form of a 256-bit nullifier given as bigint, decimal or 0x-hex. */
export function normalizeNullifier(value: string | bigint): string {
  let n: bigint;
  if (typeof value === "bigint") n = value;
  else if (/^0x[0-9a-fA-F]{1,64}$/.test(value)) n = BigInt(value);
  else if (/^[0-9]{1,78}$/.test(value)) n = BigInt(value);
  else throw new TypeError("nullifier must be a decimal or 0x-hex string");
  if (n < 0n || n >= 1n << 256n) throw new RangeError("nullifier out of 256-bit range");
  return n.toString(10);
}

const now = () => Math.floor(Date.now() / 1000);

function toSession(row: Record<string, unknown> | undefined): SessionRecord | null {
  if (!row) return null;
  return {
    humanId: String(row.human_id) as `0x${string}`,
    sessionId: String(row.session_id),
    account: String(row.account) as `0x${string}`,
    credentialLevel: Number(row.credential_level) as CredentialLevel,
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

    saveSession: (rec) =>
      insertOnce(
        "INSERT INTO sessions (human_id, session_id, account, credential_level, created_at) VALUES (?, ?, ?, ?, ?)",
        [rec.humanId.toLowerCase(), rec.sessionId, rec.account.toLowerCase(), rec.credentialLevel, now()],
      ),

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
