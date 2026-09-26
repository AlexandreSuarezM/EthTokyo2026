import { readFileSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  EnvError,
  LOCAL_DATABASE_URL,
  PUBLIC_ENV_VARS,
  SEPOLIA_CHAIN_ID,
  SERVER_ENV_VARS,
  isSimulated,
  missingEnv,
  parseServerEnv,
  simulatedMark,
} from "@/lib/env";

// Fresh random keys per run: no key material in the repo.
const valid = {
  WORLD_RP_ID: "rp_test123",
  WORLD_SIGNING_KEY: generatePrivateKey().slice(2),
  ATTESTER_PRIVATE_KEY: generatePrivateKey(),
  RELAYER_PRIVATE_KEY: generatePrivateKey(),
  SEPOLIA_RPC_URL: "https://rpc.example.org/v2/key",
  NEXT_PUBLIC_WORLD_APP_ID: "app_test",
};

function problems(env: Record<string, string | undefined>): string[] {
  try {
    parseServerEnv(env);
  } catch (e) {
    if (e instanceof EnvError) return e.problems;
    throw e;
  }
  return [];
}

describe("env", () => {
  it("reports unset variables", () => {
    expect(missingEnv(["A", "B"], { A: "x" })).toEqual(["B"]);
  });

  it("matches .env.example", () => {
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    const declared = [...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]).sort();
    expect(declared).toEqual([...SERVER_ENV_VARS, ...PUBLIC_ENV_VARS].sort());
  });

  it("never exposes server variables to the browser", () => {
    for (const name of SERVER_ENV_VARS) expect(name.startsWith("NEXT_PUBLIC_")).toBe(false);
  });
});

describe("parseServerEnv", () => {
  it("accepts a valid environment with development defaults", () => {
    const env = parseServerEnv(valid);
    expect(env.CHAIN_ID).toBe(SEPOLIA_CHAIN_ID);
    expect(env.DATABASE_URL).toBe(LOCAL_DATABASE_URL);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.WORLD_ID_MODE).toBe("real");
  });

  it("accepts WORLD_ID_MODE real|simulated only, and marks simulated responses", () => {
    expect(parseServerEnv({ ...valid, WORLD_ID_MODE: "simulated" }).WORLD_ID_MODE).toBe("simulated");
    expect(problems({ ...valid, WORLD_ID_MODE: "fake" }).join()).toContain("WORLD_ID_MODE");
    expect(isSimulated({ WORLD_ID_MODE: "simulated" })).toBe(true);
    expect(isSimulated({})).toBe(false);
    expect(simulatedMark({ WORLD_ID_MODE: "simulated" })).toEqual({ simulated: true });
    expect(simulatedMark({ WORLD_ID_MODE: "real" })).toEqual({});
  });

  it("normalises private keys to 0x-prefixed hex", () => {
    const env = parseServerEnv({ ...valid, ATTESTER_PRIVATE_KEY: valid.ATTESTER_PRIVATE_KEY.slice(2) });
    expect(env.ATTESTER_PRIVATE_KEY).toBe(valid.ATTESTER_PRIVATE_KEY);
  });

  it("fails fast on missing variables, naming each one", () => {
    expect(problems({})).toEqual(
      expect.arrayContaining([
        "WORLD_RP_ID: missing",
        "WORLD_SIGNING_KEY: missing",
        "ATTESTER_PRIVATE_KEY: missing",
        "RELAYER_PRIVATE_KEY: missing",
        "SEPOLIA_RPC_URL: missing",
      ]),
    );
  });

  it("requires DATABASE_URL in production", () => {
    expect(problems({ ...valid, NODE_ENV: "production" })).toEqual(["DATABASE_URL: missing"]);
    expect(problems({ ...valid, NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@db.neon.tech/x" })).toEqual([]);
  });

  it("rejects malformed values without echoing them", () => {
    const bad = { ...valid, WORLD_SIGNING_KEY: "not-a-key-SECRET", SEPOLIA_RPC_URL: "ftp://x", DATABASE_URL: "mysql://x" };
    let error: unknown;
    try {
      parseServerEnv(bad);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    const message = (error as Error).message;
    expect(message).toContain("WORLD_SIGNING_KEY");
    expect(message).toContain("SEPOLIA_RPC_URL");
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain("SECRET");
  });

  it("refuses the same key for attester and relayer", () => {
    expect(problems({ ...valid, RELAYER_PRIVATE_KEY: valid.ATTESTER_PRIVATE_KEY })).toEqual([
      "RELAYER_PRIVATE_KEY: must differ from ATTESTER_PRIVATE_KEY",
    ]);
  });

  it("refuses a server secret copied into a NEXT_PUBLIC_ variable", () => {
    const leaked = { ...valid, NEXT_PUBLIC_KEY: valid.RELAYER_PRIVATE_KEY };
    expect(problems(leaked)).toEqual(["NEXT_PUBLIC_KEY: holds a server secret; it would be exposed to the browser"]);
  });
});
