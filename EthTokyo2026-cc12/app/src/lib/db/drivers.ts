import "server-only";
import { toPostgresPlaceholders, type Driver } from "@/lib/db/store";

/** SQLite through Node's built-in node:sqlite (local development and tests). */
export async function sqliteDriver(databaseUrl: string): Promise<Driver> {
  const { DatabaseSync } = await import("node:sqlite");
  const path = databaseUrl.replace(/^file:/, "");
  const db = new DatabaseSync(path === "" ? ":memory:" : path);
  return {
    dialect: "sqlite",
    query: async (sql, params) =>
      db.prepare(sql).all(...(params as (string | number | bigint | null)[])) as Record<string, unknown>[],
    close: async () => db.close(),
  };
}

/** Neon Postgres over HTTP (deployment). */
export async function neonDriver(databaseUrl: string): Promise<Driver> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(databaseUrl);
  return {
    dialect: "postgres",
    query: async (text, params) => (await sql.query(toPostgresPlaceholders(text), params)) as Record<string, unknown>[],
    close: async () => {},
  };
}

export function driverFor(databaseUrl: string): Promise<Driver> {
  if (databaseUrl.startsWith("file:")) return sqliteDriver(databaseUrl);
  if (/^postgres(ql)?:\/\//.test(databaseUrl)) return neonDriver(databaseUrl);
  throw new Error("DATABASE_URL must start with file: or postgres://");
}
