import { hashTypedData, recoverTypedDataAddress, zeroHash, type Address, type Hash, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPROVAL_TYPES, ATTESTATION_TYPES, createAttester, receiptsDomain, type Domains } from "@/lib/chain/attester";
import { RelayError, type ValidateArgs } from "@/lib/chain/relayer";
import { sqliteDriver } from "@/lib/db/drivers";
import { createStore, type Store } from "@/lib/db/store";
import { handleJson } from "@/lib/http/handler";
import { commitHashOf, repoIdOf, type Change, type RepoSource } from "@/lib/repo/source";
import {
  APPROVAL_TTL_SECONDS,
  approvalKey,
  approveSignal,
  completeApproval,
  prepareApproval,
  type ApproveDeps,
  type PrepareResult,
} from "@/lib/world/approve";
import { WorldError } from "@/lib/world/errors";
import { denyProposal, openProposal, reviseProposal } from "@/lib/world/proposals";
import { mockFetch, newSessionId, rand32, sessionResult, worldAccepts } from "@/test/world";

const attesterAccount = privateKeyToAccount(generatePrivateKey());
const NOW = 1_800_000_000;
const BASE = "1".repeat(40);
const chain: Domains = {
  chainId: 11155111,
  humanRegistry: "0x00000000000000000000000000000000000000a1",
  validationReceipts: "0x00000000000000000000000000000000000000b2",
};

/** A repository whose branches the test can move. */
function fakeRepos() {
  const heads = new Map<string, Change>();
  const set = (ref: string, sha: string, diff = `diff --git a/x b/x\n+${sha}\n`, linesChanged = 12) =>
    heads.set(ref, { baseSha: BASE, headSha: sha, diff, linesChanged });
  const source: RepoSource = {
    inspect: async (repo, baseRef, headRef) => {
      if (repo !== "acme/web" || (baseRef !== "main" && baseRef !== BASE)) throw new WorldError("invalid_request", "unknown");
      const head = heads.get(headRef);
      if (!head) throw new WorldError("invalid_request", "unknown ref");
      return { ...head };
    },
  };
  return { source, set };
}

type Human = { wallet: PrivateKeyAccount; humanId: Hex; sessionId: string };

type Harness = {
  deps: ApproveDeps;
  store: Store;
  world: ReturnType<typeof mockFetch>;
  repos: ReturnType<typeof fakeRepos>;
  relayed: ValidateArgs[];
  relayer: { fail?: RelayError | Error };
  humans: Map<Address, Hex>;
  clock: { now: number };
  enroll(level?: 1 | 2): Promise<Human>;
};

async function harness(world = worldAccepts()): Promise<Harness> {
  const store = await createStore(await sqliteDriver("file::memory:"));
  const repos = fakeRepos();
  repos.set("agent/task-1", "a".repeat(40));
  const humans = new Map<Address, Hex>();
  const relayed: ValidateArgs[] = [];
  const relayer: Harness["relayer"] = {};
  const clock = { now: NOW };
  let id = 0;
  let nonce = 0n;
  const deps: ApproveDeps = {
    store,
    repos: repos.source,
    verify: { rpId: "rp_test", environment: "production", fetch: world.fetch },
    registry: { humanOf: async (a) => humans.get(a) ?? zeroHash },
    attester: createAttester(attesterAccount, chain),
    relayer: {
      submitValidate: async (args) => {
        if (relayer.fail) throw relayer.fail;
        relayed.push(args);
        return { txHash: `0x${"ee".repeat(32)}` as Hash, receiptId: BigInt(relayed.length) };
      },
    },
    chain,
    now: () => clock.now,
    randomId: () => (++id).toString(16).padStart(64, "0"),
    randomNonce: () => ++nonce,
  };
  const enroll = async (level: 1 | 2 = 1): Promise<Human> => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const humanId = rand32();
    const sessionId = newSessionId();
    await store.saveSession({ humanId, sessionId, account: wallet.address, credentialLevel: level, enrollNullifier: BigInt(humanId).toString(), sybilScore: null });
    humans.set(wallet.address, humanId);
    return { wallet, humanId, sessionId };
  };
  return { deps, store, world, repos, relayed, relayer, humans, clock, enroll };
}

async function codeOf(p: Promise<unknown>) {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(WorldError);
  return (e as WorldError).code;
}

const submitter = privateKeyToAccount(generatePrivateKey()).address;

async function open(h: Harness, headRef = "agent/task-1") {
  return openProposal(h.deps, { repo: "acme/web", baseRef: "main", headRef, task: "Add a footer", modelId: "model-x", submitter });
}

const sign = (wallet: PrivateKeyAccount, prep: PrepareResult) =>
  wallet.signTypedData({
    domain: prep.typedData.domain,
    types: APPROVAL_TYPES,
    primaryType: "HumanApproval",
    message: { ...prep.typedData.message, nonce: BigInt(prep.typedData.message.nonce), deadline: BigInt(prep.typedData.message.deadline) },
  });

/** What the UI sends: the wallet signature and a proveSession result bound to the approval. */
async function acceptBody(h: Human, prep: PrepareResult, opts: { sessionId?: string; schema?: number; sessionNullifier?: string; signal?: string } = {}) {
  return {
    approvalId: prep.approvalId,
    signature: await sign(h.wallet, prep),
    result: sessionResult({
      enrollmentId: "unused",
      sessionId: opts.sessionId ?? h.sessionId,
      schema: opts.schema,
      sessionNullifier: opts.sessionNullifier,
      signal: opts.signal ?? prep.signal,
    }),
  };
}

describe("deny with new input", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.store.close());

  it("closes the proposal, rebuilds the context, and the next round is a new proposal; no receipt", async () => {
    const p1 = await open(h);
    expect(p1).toMatchObject({ round: 1, feedback: [], commitHash: commitHashOf("a".repeat(40)), repoId: repoIdOf("acme/web") });

    const denied = await denyProposal(h.deps, { proposalId: p1.id, input: "Use the brand colors" });
    expect(denied.next).toEqual({ parentId: p1.id, repo: "acme/web", baseSha: BASE, task: "Add a footer", feedback: ["Use the brand colors"], round: 2 });

    h.repos.set("agent/task-1-r2", "b".repeat(40));
    const p2 = await reviseProposal(h.deps, { parentId: p1.id, headRef: "agent/task-1-r2", modelId: "model-x" });
    expect(p2).toMatchObject({ round: 2, threadId: p1.id, feedback: ["Use the brand colors"], task: "Add a footer" });
    expect(p2.id).not.toBe(p1.id);
    expect(p2.contextHash).not.toBe(p1.contextHash);

    await denyProposal(h.deps, { proposalId: p2.id, input: "Smaller" });
    h.repos.set("agent/task-1-r3", "c".repeat(40));
    const p3 = await reviseProposal(h.deps, { parentId: p2.id, headRef: "agent/task-1-r3", modelId: "model-x" });
    expect(p3.feedback).toEqual(["Use the brand colors", "Smaller"]);
    expect(p3.round).toBe(3);

    expect(h.relayed).toHaveLength(0); // a deny never records anything
    expect(h.world.calls).toHaveLength(0);
  });

  it("requires new input, denies once, revises once", async () => {
    const p1 = await open(h);
    expect(await codeOf(denyProposal(h.deps, { proposalId: p1.id, input: "   " }))).toBe("invalid_request");
    await denyProposal(h.deps, { proposalId: p1.id, input: "No" });
    expect(await codeOf(denyProposal(h.deps, { proposalId: p1.id, input: "No again" }))).toBe("stale");

    h.repos.set("r2", "b".repeat(40));
    await reviseProposal(h.deps, { parentId: p1.id, headRef: "r2", modelId: "m" });
    expect(await codeOf(reviseProposal(h.deps, { parentId: p1.id, headRef: "r2", modelId: "m" }))).toBe("replayed");
  });

  it("an open proposal can't be revised, and a denied one can't be accepted", async () => {
    const p1 = await open(h);
    expect(await codeOf(reviseProposal(h.deps, { parentId: p1.id, headRef: "agent/task-1", modelId: "m" }))).toBe("stale");
    await denyProposal(h.deps, { proposalId: p1.id, input: "No" });
    expect(await codeOf(prepareApproval(h.deps, { proposalId: p1.id }))).toBe("stale");
  });

  it("refuses an empty change", async () => {
    h.repos.set("empty", BASE, "", 0);
    expect(await codeOf(open(h, "empty"))).toBe("invalid_request");
  });
});

describe("accept → receipt", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(() => h.store.close());

  it("happy path: server-built approval, World ID at that moment, attester + wallet signatures, one receipt", async () => {
    const v = await h.enroll();
    await denyProposal(h.deps, { proposalId: (await open(h)).id, input: "Use the brand colors" });
    h.repos.set("r2", "b".repeat(40));
    const p2 = await reviseProposal(h.deps, { parentId: (await h.store.getProposal("1".padStart(64, "0")))!.id, headRef: "r2", modelId: "model-x" });

    const prep = await prepareApproval(h.deps, { proposalId: p2.id });
    const m = prep.typedData.message;
    expect(m).toMatchObject({
      repoId: repoIdOf("acme/web"),
      commitHash: commitHashOf("b".repeat(40)), // read from the repository
      contextHash: p2.contextHash,
      submitter,
      linesChanged: 12,
      rounds: 1, // one deny before this accept
      deadline: String(NOW + APPROVAL_TTL_SECONDS),
      sessionId: `0x${p2.threadId}`,
    });
    expect(prep.signal).toBe(approveSignal(prep.approvalDigest));

    const res = await completeApproval(h.deps, await acceptBody(v, prep));
    expect(res).toMatchObject({ status: "recorded", receiptId: "1", humanId: v.humanId, repo: "acme/web", commitHash: m.commitHash });

    // World was asked once, in the configured environment
    expect(h.world.calls).toHaveLength(1);
    expect(h.world.calls[0].body.environment).toBe("production");

    // validate() got exactly the server's approval, the wallet signature, and an attester signature over it
    expect(h.relayed).toHaveLength(1);
    const [approval, sig, , att] = h.relayed[0];
    expect(approval).toEqual({ ...m, nonce: BigInt(m.nonce), deadline: BigInt(m.deadline) });
    const digest = hashTypedData({ domain: receiptsDomain(chain), types: APPROVAL_TYPES, primaryType: "HumanApproval", message: approval });
    expect(digest).toBe(prep.approvalDigest);
    expect(await recoverTypedDataAddress({ domain: receiptsDomain(chain), types: APPROVAL_TYPES, primaryType: "HumanApproval", message: approval, signature: sig })).toBe(
      v.wallet.address,
    );
    expect(
      await recoverTypedDataAddress({
        domain: receiptsDomain(chain),
        types: ATTESTATION_TYPES,
        primaryType: "HumanAttestation",
        message: { approvalDigest: digest, proofRef: att.proofRef, presence: false },
        signature: att.signature,
      }),
    ).toBe(attesterAccount.address);
    expect(att.presence).toBe(false);

    const saved = await h.store.receiptOf(approvalKey(m.repoId, m.commitHash, v.humanId));
    expect(saved).toMatchObject({ receiptId: "1", proposalId: p2.id, proofRef: att.proofRef });
  });

  it("the client can't choose the commit: extra fields are refused, and a tampered signature maps to nobody", async () => {
    const v = await h.enroll();
    const p = await open(h);
    expect(await codeOf(prepareApproval(h.deps, { proposalId: p.id, commitHash: rand32() }))).toBe("invalid_request");

    const prep = await prepareApproval(h.deps, { proposalId: p.id });
    const tampered = { ...prep, typedData: { ...prep.typedData, message: { ...prep.typedData.message, commitHash: rand32() } } };
    const body = await acceptBody(v, prep);
    body.signature = await sign(v.wallet, tampered); // signed a different commit
    expect(await codeOf(completeApproval(h.deps, body))).toBe("not_enrolled");
    expect(h.relayed).toHaveLength(0);
  });

  it("refuses when the branch moved after it was shown (commit recomputed on the server)", async () => {
    const v = await h.enroll();
    const p = await open(h);
    const prep = await prepareApproval(h.deps, { proposalId: p.id });
    h.repos.set("agent/task-1", "d".repeat(40)); // someone pushed to the branch
    expect(await codeOf(completeApproval(h.deps, await acceptBody(v, prep)))).toBe("stale");
    expect(await codeOf(prepareApproval(h.deps, { proposalId: p.id }))).toBe("stale");
    expect(h.relayed).toHaveLength(0);
  });

  it("one approval = one receipt: replays and a second approval of the same change are refused", async () => {
    const v = await h.enroll();
    const p = await open(h);
    const prep = await prepareApproval(h.deps, { proposalId: p.id });
    const body = await acceptBody(v, prep);
    await completeApproval(h.deps, body);
    expect(await codeOf(completeApproval(h.deps, body))).toBe("expired"); // the pending approval is gone

    const again = await prepareApproval(h.deps, { proposalId: p.id });
    expect(await codeOf(completeApproval(h.deps, await acceptBody(v, again)))).toBe("replayed");
    expect(h.relayed).toHaveLength(1);
  });

  it("concurrent completes of one approval relay exactly once", async () => {
    const v = await h.enroll();
    const prep = await prepareApproval(h.deps, { proposalId: (await open(h)).id });
    const body = await acceptBody(v, prep);
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => completeApproval(h.deps, body)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(h.relayed).toHaveLength(1);
  });

  it("a second validator can approve the same change (their own receipt)", async () => {
    const a = await h.enroll();
    const b = await h.enroll();
    const p = await open(h);
    await completeApproval(h.deps, await acceptBody(a, await prepareApproval(h.deps, { proposalId: p.id })));
    await completeApproval(h.deps, await acceptBody(b, await prepareApproval(h.deps, { proposalId: p.id })));
    expect(h.relayed).toHaveLength(2);
  });

  it("refuses a reused World ID proof (session nullifier)", async () => {
    const v = await h.enroll();
    const sessionNullifier = rand32();
    const p1 = await open(h);
    await completeApproval(h.deps, await acceptBody(v, await prepareApproval(h.deps, { proposalId: p1.id }), { sessionNullifier }));

    h.repos.set("other", "e".repeat(40));
    const p2 = await open(h, "other");
    const prep = await prepareApproval(h.deps, { proposalId: p2.id });
    expect(await codeOf(completeApproval(h.deps, await acceptBody(v, prep, { sessionNullifier })))).toBe("replayed");
  });

  it("refuses a proof made for another approval, without calling World", async () => {
    const v = await h.enroll();
    const prep = await prepareApproval(h.deps, { proposalId: (await open(h)).id });
    expect(await codeOf(completeApproval(h.deps, await acceptBody(v, prep, { signal: approveSignal(rand32()) })))).toBe("rejected");
    expect(h.world.calls).toHaveLength(0);
  });

  it("not enrolled: a session_id that maps to nobody, or a wallet that isn't enrolled", async () => {
    const v = await h.enroll();
    const prep = await prepareApproval(h.deps, { proposalId: (await open(h)).id });
    expect(await codeOf(completeApproval(h.deps, await acceptBody(v, prep, { sessionId: newSessionId() })))).toBe("not_enrolled");

    const stranger = { ...v, wallet: privateKeyToAccount(generatePrivateKey()) };
    expect(await codeOf(completeApproval(h.deps, await acceptBody(stranger, prep)))).toBe("not_enrolled");
    expect(h.relayed).toHaveLength(0);
  });

  it("refuses a wallet of another human signing with my proof", async () => {
    const me = await h.enroll();
    const other = await h.enroll();
    const prep = await prepareApproval(h.deps, { proposalId: (await open(h)).id });
    const body = await acceptBody(me, prep);
    body.signature = await sign(other.wallet, prep);
    expect(await codeOf(completeApproval(h.deps, body))).toBe("rejected");
    expect(h.relayed).toHaveLength(0);
  });

  it("refuses a proof with a different credential than the enrollment", async () => {
    const v = await h.enroll(1);
    const prep = await prepareApproval(h.deps, { proposalId: (await open(h)).id });
    expect(await codeOf(completeApproval(h.deps, await acceptBody(v, prep, { schema: 11 })))).toBe("rejected");
  });

  it("World cancelled / unavailable: typed error, nothing consumed, retry works", async () => {
    const v = await h.enroll();
    const prep = await prepareApproval(h.deps, { proposalId: (await open(h)).id });
    const body = await acceptBody(v, prep);

    const cancelled = mockFetch({ status: 400, body: { code: "all_verifications_failed", results: [{ code: "user_rejected" }] } });
    expect(await codeOf(completeApproval({ ...h.deps, verify: { ...h.deps.verify, fetch: cancelled.fetch } }, body))).toBe("cancelled");
    const down = mockFetch({ throws: true });
    expect(await codeOf(completeApproval({ ...h.deps, verify: { ...h.deps.verify, fetch: down.fetch } }, body))).toBe(
      "verification_unavailable",
    );
    const staging = mockFetch({ body: { success: true, environment: "staging", session_id: body.result.session_id, results: [{ identifier: "proof_of_human", success: true }] } });
    expect(await codeOf(completeApproval({ ...h.deps, verify: { ...h.deps.verify, fetch: staging.fetch } }, body))).toBe("rejected");

    expect(h.relayed).toHaveLength(0);
    expect((await completeApproval(h.deps, body)).status).toBe("recorded");
  });

  it("expired: the approval times out", async () => {
    const v = await h.enroll();
    const prep = await prepareApproval(h.deps, { proposalId: (await open(h)).id });
    h.clock.now += APPROVAL_TTL_SECONDS + 1;
    expect(await codeOf(completeApproval(h.deps, await acceptBody(v, prep)))).toBe("expired");
  });

  it("ineligible (banned, no permission, Selfie on a high tier): typed error, no transaction, key released", async () => {
    const v = await h.enroll();
    const p = await open(h);
    for (const [name, code] of [
      ["Banned", "ineligible"],
      ["InsufficientPermission", "ineligible"],
      ["UnknownHuman", "not_enrolled"],
      ["SomethingNew", "rejected"],
    ] as const) {
      h.relayer.fail = new RelayError("reverted", name);
      expect(await codeOf(completeApproval(h.deps, await acceptBody(v, await prepareApproval(h.deps, { proposalId: p.id }))))).toBe(code);
    }
    expect(h.relayed).toHaveLength(0);

    h.relayer.fail = undefined; // e.g. the permission was granted: approving again works
    expect((await completeApproval(h.deps, await acceptBody(v, await prepareApproval(h.deps, { proposalId: p.id })))).status).toBe("recorded");
  });

  it("a transaction that may have been sent keeps the approval consumed (no second receipt)", async () => {
    const v = await h.enroll();
    const p = await open(h);
    h.relayer.fail = new RelayError("failed", undefined, `0x${"ab".repeat(32)}`);
    expect(await codeOf(completeApproval(h.deps, await acceptBody(v, await prepareApproval(h.deps, { proposalId: p.id }))))).toBe(
      "verification_unavailable",
    );
    h.relayer.fail = undefined;
    expect(await codeOf(completeApproval(h.deps, await acceptBody(v, await prepareApproval(h.deps, { proposalId: p.id }))))).toBe(
      "replayed",
    );
  });

  it("malformed input", async () => {
    const v = await h.enroll();
    const prep = await prepareApproval(h.deps, { proposalId: (await open(h)).id });
    const body = await acceptBody(v, prep);
    expect(await codeOf(completeApproval(h.deps, { ...body, signature: "0x12" }))).toBe("invalid_request");
    expect(await codeOf(completeApproval(h.deps, { ...body, extra: true }))).toBe("invalid_request");
    expect(await codeOf(completeApproval(h.deps, { ...body, result: { protocol_version: "3.0" } }))).toBe("invalid_request");
    expect(await codeOf(prepareApproval(h.deps, { proposalId: "f".repeat(64) }))).toBe("invalid_request");
  });

  it("route handler returns typed errors with no-store", async () => {
    const res = await handleJson("approve", new Request("http://localhost", { method: "POST", body: JSON.stringify({ proposalId: "x" }) }), async () => h.deps, prepareApproval);
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });
});
