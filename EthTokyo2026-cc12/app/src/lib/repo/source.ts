import "server-only";
import { execFile } from "node:child_process";
import path from "node:path";
import { keccak256, pad, stringToHex, type Hex } from "viem";
import { WorldError } from "@/lib/world/errors";

/**
 * Where the server reads a proposed change from. The commit hash, the diff and the line count
 * always come from the repository itself, never from the client or the LLM.
 */

export type Change = {
  baseSha: string;
  headSha: string;
  /** Unified diff base..head, exactly as git prints it. */
  diff: string;
  /** Lines added + removed (git diff --numstat). */
  linesChanged: number;
};

export interface RepoSource {
  /** Resolves both refs to commits and reads the change between them. */
  inspect(repo: string, baseRef: string, headRef: string): Promise<Change>;
}

/** "owner/name", one level deep; no ".", ".." or anything a path could escape with. */
export const REPO_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
/** A branch, tag or sha: never starts with "-" (no option injection), no "..". */
export const GIT_REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/;
const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export const isRepoName = (v: string) => REPO_NAME.test(v) && !v.includes("..");
export const isGitRef = (v: string) => GIT_REF.test(v) && !v.includes("..");

/** On-chain repo id, same as Deploy.s.sol: keccak256(bytes(name)). */
export const repoIdOf = (repo: string): Hex => keccak256(stringToHex(repo));

/** On-chain commit hash: the git sha itself, left-padded to 32 bytes (SHA-1) or as-is (SHA-256). */
export function commitHashOf(sha: string): Hex {
  if (!SHA.test(sha)) throw new TypeError("not a git commit sha");
  return pad(`0x${sha}`, { size: 32 });
}

type Run = (args: string[]) => Promise<string>;

const gitRunner =
  (cwd: string): Run =>
  (args) =>
    new Promise((resolve, reject) =>
      execFile("git", ["-C", cwd, ...args], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      ),
    );

/** Reads changes from local checkouts under `root`: <root>/<owner>/<name>. */
export function localGitSource(root: string, runner: (cwd: string) => Run = gitRunner): RepoSource {
  return {
    async inspect(repo, baseRef, headRef) {
      if (!isRepoName(repo)) throw new WorldError("invalid_request", "Unknown repository.");
      if (!isGitRef(baseRef) || !isGitRef(headRef)) throw new WorldError("invalid_request", "Malformed git ref.");
      const run = runner(path.join(root, ...repo.split("/")));

      const resolve = async (ref: string) => {
        let out: string;
        try {
          out = await run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
        } catch {
          throw new WorldError("invalid_request", "The repository or ref was not found.");
        }
        const sha = out.trim();
        if (!SHA.test(sha)) throw new WorldError("verification_unavailable", "git returned an unexpected commit id.");
        return sha;
      };

      const baseSha = await resolve(baseRef);
      const headSha = await resolve(headRef);
      let diff: string, numstat: string;
      try {
        // Resolved shas, not refs: the three reads describe exactly the same change.
        diff = await run(["diff", "--no-color", "--no-ext-diff", "--no-renames", baseSha, headSha]);
        numstat = await run(["diff", "--numstat", "--no-renames", baseSha, headSha]);
      } catch {
        throw new WorldError("verification_unavailable", "Could not read the change from the repository.");
      }
      let linesChanged = 0;
      for (const line of numstat.split("\n")) {
        const [added, removed] = line.split("\t");
        // Binary files print "-": count them as one changed line each, never as zero.
        if (added !== undefined && removed !== undefined) linesChanged += added === "-" ? 1 : Number(added) + Number(removed);
      }
      return { baseSha, headSha, diff, linesChanged };
    },
  };
}

/** Used when REPOS_ROOT is unset: every approval fails closed. */
export const noRepoSource: RepoSource = {
  inspect: async () => {
    throw new WorldError("verification_unavailable", "No repository source is configured on the server.");
  },
};
