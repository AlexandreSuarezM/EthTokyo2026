import { z } from "zod";

// Keep in sync with /.env.example.
export const SERVER_ENV_VARS = [
  "WORLD_RP_ID",
  "WORLD_SIGNING_KEY",
  "WORLD_ENVIRONMENT",
  "ATTESTER_PRIVATE_KEY",
  "RELAYER_PRIVATE_KEY",
  "SEPOLIA_RPC_URL",
  "CHAIN_ID",
  "GITHUB_TOKEN",
  "DATABASE_URL",
] as const;

export const PUBLIC_ENV_VARS = ["NEXT_PUBLIC_WORLD_APP_ID"] as const;

// Values that must never reach the browser, whatever variable they are copied into.
const SECRET_VARS = [
  "WORLD_SIGNING_KEY",
  "ATTESTER_PRIVATE_KEY",
  "RELAYER_PRIVATE_KEY",
  "SEPOLIA_RPC_URL",
  "GITHUB_TOKEN",
  "DATABASE_URL",
] as const;

export const LOCAL_DATABASE_URL = "file:./dev.db";
export const SEPOLIA_CHAIN_ID = 11155111;

export function missingEnv(
  names: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  return names.filter((name) => !env[name]);
}

const hex32 = /^(0x)?[0-9a-fA-F]{64}$/;
const privateKey = z
  .string()
  .regex(hex32, "must be a 32-byte hex key")
  .transform((v) => (v.startsWith("0x") ? v : `0x${v}`) as `0x${string}`);

const serverSchema = z
  .object({
    WORLD_RP_ID: z.string().regex(/^rp_\S+$/, "must look like rp_..."),
    WORLD_SIGNING_KEY: z.string().regex(hex32, "must be a 32-byte hex key"),
    // "staging" only for the World simulator; a deployment accepts exactly one environment.
    WORLD_ENVIRONMENT: z.enum(["production", "staging"]),
    ATTESTER_PRIVATE_KEY: privateKey,
    RELAYER_PRIVATE_KEY: privateKey,
    SEPOLIA_RPC_URL: z.url({ protocol: /^https?$/ }),
    CHAIN_ID: z.coerce.number().int().positive(),
    GITHUB_TOKEN: z.string().min(1).optional(),
    DATABASE_URL: z
      .string()
      .regex(/^(file:|postgres(ql)?:\/\/)/, "must start with file: or postgres://"),
  })
  .refine((e) => e.ATTESTER_PRIVATE_KEY.toLowerCase() !== e.RELAYER_PRIVATE_KEY.toLowerCase(), {
    path: ["RELAYER_PRIVATE_KEY"],
    message: "must differ from ATTESTER_PRIVATE_KEY",
  });

export type ServerEnv = z.infer<typeof serverSchema>;

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    // Names and rules only: never echo a value.
    super(`Invalid server environment:\n  - ${problems.join("\n  - ")}`);
    this.name = "EnvError";
  }
}

/** Validates the server environment. Throws an EnvError that never contains a value. */
export function parseServerEnv(env: Record<string, string | undefined>): ServerEnv {
  const production = env.NODE_ENV === "production";
  const input = {
    ...Object.fromEntries(SERVER_ENV_VARS.map((name) => [name, env[name] || undefined])),
    CHAIN_ID: env.CHAIN_ID || String(SEPOLIA_CHAIN_ID),
    WORLD_ENVIRONMENT: env.WORLD_ENVIRONMENT || "production",
    DATABASE_URL: env.DATABASE_URL || (production ? undefined : LOCAL_DATABASE_URL),
  };

  const problems: string[] = [];
  const result = serverSchema.safeParse(input);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const name = String(issue.path[0] ?? "env");
      problems.push(input[name as keyof typeof input] === undefined ? `${name}: missing` : `${name}: ${issue.message}`);
    }
  }

  // A secret copied into a NEXT_PUBLIC_ variable would be bundled into client code.
  const secrets = new Set(SECRET_VARS.map((name) => env[name]).filter((v): v is string => !!v));
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("NEXT_PUBLIC_") && value && secrets.has(value)) {
      problems.push(`${name}: holds a server secret; it would be exposed to the browser`);
    }
  }

  if (problems.length > 0 || !result.success) throw new EnvError(problems);
  return result.data;
}
