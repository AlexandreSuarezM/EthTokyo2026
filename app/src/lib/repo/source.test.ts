import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { keccak256, stringToHex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { commitHashOf, isGitRef, isRepoName, localGitSource, noRepoSource, repoIdOf } from "@/lib/repo/source";
import { WorldError } from "@/lib/world/errors";

const root = mkdtempSync(path.join(tmpdir(), "hitl-repos-"));
const dir = path.join(root, "acme", "web");
const git = (...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.org", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
  }).trim();

let baseSha: string;
let headSha: string;

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  baseSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "agent/task-1");
  writeFileSync(path.join(dir, "a.txt"), "one\n2\nthree\nfour\n"); // 2 added, 1 removed
  writeFileSync(path.join(dir, "b.bin"), Buffer.from([0, 1, 2, 0, 255]));
  git("add", ".");
  git("commit", "-q", "-m", "change");
  headSha = git("rev-parse", "HEAD");
});

async function codeOf(p: Promise<unknown>) {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(WorldError);
  return (e as WorldError).code;
}

describe("localGitSource", () => {
  it("reads the change from the repository: shas, diff and line count", async () => {
    const change = await localGitSource(root).inspect("acme/web", "main", "agent/task-1");
    expect(change.baseSha).toBe(baseSha);
    expect(change.headSha).toBe(headSha);
    expect(change.diff).toContain("+four");
    expect(change.linesChanged).toBe(3 + 1); // text: 2 added + 1 removed; the binary file counts as 1
  });

  it("accepts shas as refs", async () => {
    const change = await localGitSource(root).inspect("acme/web", baseSha, headSha);
    expect(change.headSha).toBe(headSha);
  });

  it("refuses names and refs that could escape the root or inject options", async () => {
    const src = localGitSource(root);
    for (const repo of ["../acme/web", "acme/../web", "acme", "acme/web/x", "/etc/passwd", "acme/.."]) {
      expect(await codeOf(src.inspect(repo, "main", "main"))).toBe("invalid_request");
    }
    for (const ref of ["--output=/tmp/x", "-c", "main..agent", "a b", ""]) {
      expect(await codeOf(src.inspect("acme/web", "main", ref))).toBe("invalid_request");
    }
  });

  it("refuses an unknown repository or ref", async () => {
    expect(await codeOf(localGitSource(root).inspect("acme/nope", "main", "main"))).toBe("invalid_request");
    expect(await codeOf(localGitSource(root).inspect("acme/web", "main", "no-such-branch"))).toBe("invalid_request");
  });

  it("fails closed when no source is configured", async () => {
    expect(await codeOf(noRepoSource.inspect("acme/web", "main", "main"))).toBe("verification_unavailable");
  });
});

describe("on-chain ids", () => {
  it("repoId matches Deploy.s.sol: keccak256(bytes(name))", () => {
    expect(repoIdOf("acme/web")).toBe(keccak256(stringToHex("acme/web")));
  });

  it("commitHash is the git sha left-padded to 32 bytes", () => {
    expect(commitHashOf("a".repeat(40))).toBe(`0x${"0".repeat(24)}${"a".repeat(40)}`);
    expect(commitHashOf("b".repeat(64))).toBe(`0x${"b".repeat(64)}`);
    expect(() => commitHashOf("xyz")).toThrow();
    expect(() => commitHashOf("A".repeat(40))).toThrow();
  });

  it("validates names and refs", () => {
    expect(isRepoName("acme/web")).toBe(true);
    expect(isRepoName("acme/..")).toBe(false);
    expect(isGitRef("agent/task-1")).toBe(true);
    expect(isGitRef("-x")).toBe(false);
  });
});
