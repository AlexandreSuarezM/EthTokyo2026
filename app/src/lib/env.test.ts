import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUBLIC_ENV_VARS, SERVER_ENV_VARS, missingEnv } from "@/lib/env";

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
