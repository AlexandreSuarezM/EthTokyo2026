// Keep in sync with /.env.example.
export const SERVER_ENV_VARS = [
  "WORLD_RP_ID",
  "WORLD_SIGNING_KEY",
  "ATTESTER_PRIVATE_KEY",
  "RELAYER_PRIVATE_KEY",
  "SEPOLIA_RPC_URL",
  "GITHUB_TOKEN",
  "DATABASE_URL",
] as const;

export const PUBLIC_ENV_VARS = ["NEXT_PUBLIC_WORLD_APP_ID"] as const;

export function missingEnv(
  names: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  return names.filter((name) => !env[name]);
}
