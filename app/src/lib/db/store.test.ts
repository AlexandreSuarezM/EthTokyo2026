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

  it("releases an approval key", async () => {
    await store.consumeApproval("merge:released");
    await store.releaseApproval("merge:released");
    expect(await store.consumeApproval("merge:released")).toBe(true);
  });

  const proposal = (id: string, parentId: string | null = null) => ({
    id,
    threadId: "t".repeat(64),
    parentId,
    repo: "acme/web",
    baseSha: "1".repeat(40),
    headRef: "agent/x",
    headSha: "2".repeat(40),
    linesChanged: 3,
    contextHash: `0x${"cc".repeat(32)}` as const,
    task: "Add a footer",
    feedback: ["first", "second, with \"quotes\""],
    round: 3,
    modelId: "model-x",
    submitter: account,
  });

  it("stores proposals; one deny wins; one revision per parent", async () => {
    expect(await store.saveProposal(proposal("p1"))).toBe(true);
    expect(await store.saveProposal(proposal("p1"))).toBe(false);
    expect(await store.getProposal("p1")).toMatchObject({ status: "open", feedback: ["first", "second, with \"quotes\""], denyInput: null, parentId: null });

    const denies = await Promise.all(["a", "b", "c"].map((input) => store.denyProposal("p1", input)));
    expect(denies.filter(Boolean)).toHaveLength(1);
    expect((await store.getProposal("p1"))?.status).toBe("denied");
    expect(await store.denyProposal("missing", "x")).toBeNull();

    expect(await store.saveProposal(proposal("p2", "p1"))).toBe(true);
    expect(await store.saveProposal(proposal("p3", "p1"))).toBe(false); // p1 already revised
    expect(await store.saveProposal(proposal("p4"))).toBe(true); // many round-1 proposals (NULL parent)
  });

  it("hands a pending approval to exactly one taker", async () => {
    const a = { id: "a1", proposalId: "p1", message: "{}", digest: `0x${"dd".repeat(32)}` as const, expiresAt: 5 };
    expect(await store.savePendingApproval(a)).toBe(true);
    expect(await store.getPendingApproval("a1")).toEqual(a);
    const taken = await Promise.all([1, 2, 3].map(() => store.takePendingApproval("a1")));
    expect(taken.filter(Boolean)).toHaveLength(1);
    expect(await store.getPendingApproval("a1")).toBeNull();
  });

  it("stores one receipt per approval key and per receipt id", async () => {
    const r = {
      approvalKey: "merge:k1",
      receiptId: "7",
      txHash: `0x${"ee".repeat(32)}` as const,
      proposalId: "p1",
      humanId: human,
      proofRef: `0x${"ff".repeat(32)}` as const,
      worldResult: "{}",
    };
    expect(await store.saveReceipt(r)).toBe(true);
    expect(await store.saveReceipt(r)).toBe(false);
    expect(await store.saveReceipt({ ...r, approvalKey: "merge:k2" })).toBe(false); // same on-chain receipt id
    expect(await store.receiptOf("merge:k1")).toMatchObject({ receiptId: "7", humanId: human });
  });
});
