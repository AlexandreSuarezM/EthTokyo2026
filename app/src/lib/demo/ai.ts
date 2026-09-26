import "server-only";
import { createHash, randomInt } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { encodeAbiParameters, keccak256, toHex, type Hex } from "viem";
import type { DemoAnswer, Store } from "@/lib/db/store";
import type { RepoSource } from "@/lib/repo/source";
import { WorldError } from "@/lib/world/errors";

/**
 * The demo "AI": no LLM. It serves hello-world variants from app/demo-data/hello-world/. A secure
 * 50/50 coin picks the correct file or one random wrong file. The verdict and a random salt stay on
 * the server; the page only ever gets the code. `commitmentOf(code, verdict, salt)` is sealed as the
 * approval's contextHash, so the judge can later prove the verdict was fixed before the user decided.
 */

export const DEMO_REPO = "demo/app";
export const DEMO_TASK = "Write a hello world function";
export const DEMO_MODEL = "fake-ai:hello-world-files";
export const CORRECT_VARIANT = "correct.js";
const BASE_SHA = "0".repeat(64);

export type Variant = { name: string; code: string };

export const DEMO_DATA_DIR = path.resolve(process.cwd(), "demo-data", "hello-world");

export function loadVariants(dir: string = DEMO_DATA_DIR): { correct: Variant; wrong: Variant[] } {
  const files = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  const all = files.map((name) => ({ name, code: readFileSync(path.join(dir, name), "utf8").replace(/\r\n/g, "\n") }));
  const correct = all.find((v) => v.name === CORRECT_VARIANT);
  const wrong = all.filter((v) => v.name !== CORRECT_VARIANT);
  if (!correct || wrong.length === 0) throw new Error("demo-data/hello-world needs correct.js and at least one wrong variant");
  return { correct, wrong };
}

/** Sealed before the user decides: keccak256(abi.encode("hitl.demo.v1", code, verdict, salt)). */
export const commitmentOf = (code: string, verdict: "right" | "wrong", salt: Hex): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "bytes32" }],
      ["hitl.demo.v1", code, verdict, salt],
    ),
  );

export type Coin = { flip(): boolean; pick(n: number): number; salt(): Hex; id(): string };

export const secureCoin: Coin = {
  flip: () => randomInt(2) === 1,
  pick: (n) => randomInt(n),
  salt: () => toHex(crypto.getRandomValues(new Uint8Array(32))),
  id: () => toHex(crypto.getRandomValues(new Uint8Array(32))).slice(2),
};

/** Asks the fake AI once and stores the answer (code + secret verdict + salt). */
export async function askAi(store: Store, coin: Coin = secureCoin, variants = loadVariants()): Promise<DemoAnswer> {
  const right = coin.flip();
  const v = right ? variants.correct : variants.wrong[coin.pick(variants.wrong.length)];
  const answer = { id: coin.id(), code: v.code, variant: v.name, verdict: right ? ("right" as const) : ("wrong" as const), salt: coin.salt() };
  if (!(await store.saveDemoAnswer(answer))) throw new WorldError("verification_unavailable", "Could not store the AI answer. Try again.");
  return { ...answer, createdAt: 0 };
}

/**
 * The repository for DEMO_REPO: each answer is one "commit". The head sha is unique per answer (so
 * approving the same code twice is two different commits), the diff is the code, and the commitment
 * is the sealed hash(code, verdict, salt).
 */
export function demoRepoSource(store: Store): RepoSource {
  return {
    async inspect(repo, _baseRef, headRef) {
      if (repo !== DEMO_REPO) throw new WorldError("invalid_request", "Unknown repository.");
      const a = await store.getDemoAnswer(headRef);
      if (!a) throw new WorldError("invalid_request", "Unknown AI answer.");
      return {
        baseSha: BASE_SHA,
        headSha: createHash("sha256").update(`hitl.demo.answer:${a.id}\n${a.code}`).digest("hex"),
        diff: a.code,
        linesChanged: a.code.trimEnd().split("\n").length,
        commitment: commitmentOf(a.code, a.verdict, a.salt),
      };
    },
  };
}

/** DEMO_REPO from the demo source; anything else from `other` (local git or none). */
export function withDemoRepo(store: Store, other: RepoSource): RepoSource {
  const demo = demoRepoSource(store);
  return { inspect: (repo, base, head) => (repo === DEMO_REPO ? demo.inspect(repo, base, head) : other.inspect(repo, base, head)) };
}
