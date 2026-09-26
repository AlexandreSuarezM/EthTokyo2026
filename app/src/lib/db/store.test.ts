import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteDriver } from "@/lib/db/drivers";
import { createStore, normalizeNullifier, toPostgresPlaceholders, type Driver, type Store } from "@/lib/db/store";

/** In-process Postgres (PGlite) standing in for Neon, so the Postgres SQL path is tested too. */
async function pgliteDriver(): Promise<Driver> {
  const db = new PGlite();
  return {
    dialect: "postgres",
    query: async (sql, params) => (await db.query<Record<string, unknown>>(toPostgresPlaceholders(sql), params)).rows,
    close: () => db.close(),
  };
}

const drivers: [string, () => Promise<Driver>][] = [
  ["sqlite", () => sqliteDriver("file::memory:")],
  ["postgres", pgliteDriver],
];

const human = `0x${"ab".repeat(32)}` as const;
const other = `0x${"cd".repeat(32)}` as const;
const account = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

describe("normalizeNullifier", () => {
  it("maps hex, decimal and bigint forms of one value to the same decimal string", () => {
    expect(normalizeNullifier("0xff")).toBe("255");
    expect(normalizeNullifier("255")).toBe("255");
    expect(normalizeNullifier(255n)).toBe("255");
  });

  it("rejects malformed and out-of-range values", () => {
    expect(() => normalizeNullifier("12abc")).toThrow();
    expect(() => normalizeNullifier("-1")).toThrow();
    expect(() => normalizeNullifier(1n << 256n)).toThrow();
  });
});

describe.each(drivers)("store (%s)", (_name, makeDriver) => {
  let store: Store;
  beforeEach(async () => {
    store = await createStore(await makeDriver());
  });
  afterEach(() => store.close());

  it("records a nullifier once per action", async () => {
    expect(await store.recordNullifier("hitl-enroll", "0x1234", human)).toBe(true);
    expect(await store.recordNullifier("hitl-enroll", "4660", other)).toBe(false); // same value in decimal
    expect(await store.recordNullifier("other-action", "0x1234")).toBe(true);
  });

  it("stores 256-bit nullifiers without loss", async () => {
    const max = (1n << 256n) - 1n;
    expect(await store.recordNullifier("a", max)).toBe(true);
    expect(await store.recordNullifier("a", `0x${"f".repeat(64)}`)).toBe(false);
  });

  it("keeps one session per human, per session_id and per enrollment nullifier", async () => {
    const base = { account, credentialLevel: 1 as const, sybilScore: null };
    expect(await store.saveSession({ ...base, humanId: human, sessionId: "session_1", enrollNullifier: "1" })).toBe(true);
    // same human, same session, same nullifier: each alone is enough to refuse
    expect(await store.saveSession({ ...base, humanId: human, sessionId: "session_2", enrollNullifier: "2" })).toBe(false);
    expect(await store.saveSession({ ...base, humanId: other, sessionId: "session_1", enrollNullifier: "3" })).toBe(false);
    expect(await store.saveSession({ ...base, humanId: other, sessionId: "session_3", enrollNullifier: "0x1" })).toBe(false);

    const byHuman = await store.sessionOfHuman(human);
    expect(byHuman).toMatchObject({
      humanId: human,
      sessionId: "session_1",
      account: account.toLowerCase(),
      credentialLevel: 1,
      enrollNullifier: "1",
      sybilScore: null,
    });
    expect((await store.humanOfSession("session_1"))?.humanId).toBe(human);
    expect(await store.humanOfSession("session_2")).toBeNull();
    expect(await store.sessionOfHuman(other)).toBeNull();
  });

  it("stores the Selfie Check sybil score", async () => {
    await store.saveSession({ humanId: other, sessionId: "s", account, credentialLevel: 2, enrollNullifier: "9", sybilScore: 1.5 });
    expect((await store.sessionOfHuman(other))?.sybilScore).toBe(1.5);
  });

  it("hands a pending enrollment to exactly one taker", async () => {
    const pending = {
      id: "a".repeat(64),
      humanId: human,
      enrollNullifier: "0x10",
      account,
      credentialLevel: 2 as const,
      sybilScore: -0.5,
      expiresAt: 2_000_000_000,
    };
    expect(await store.savePending(pending)).toBe(true);
    expect(await store.savePending(pending)).toBe(false);
    expect(await store.getPending(pending.id)).toMatchObject({ enrollNullifier: "16", sybilScore: -0.5 });

    const taken = await Promise.all(Array.from({ length: 10 }, () => store.takePending(pending.id)));
    expect(taken.filter(Boolean)).toHaveLength(1);
    expect(await store.getPending(pending.id)).toBeNull();
  });

  it("consumes an approval exactly once", async () => {
    expect(await store.consumeApproval("merge:repo:0xabc")).toBe(true);
    expect(await store.consumeApproval("merge:repo:0xabc")).toBe(false);
    await expect(store.consumeApproval("")).rejects.toThrow();
  });

  it("lets only one of many concurrent consumers win", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => store.consumeApproval("merge:race")));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
