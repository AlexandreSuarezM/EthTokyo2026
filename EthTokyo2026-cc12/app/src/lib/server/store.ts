import "server-only";
import { driverFor } from "@/lib/db/drivers";
import { createStore, type Store } from "@/lib/db/store";
import { serverEnv } from "@/lib/server/env";

let store: Promise<Store> | undefined;

/** The app's store, from DATABASE_URL (SQLite locally, Neon Postgres when deployed). */
export function getStore(): Promise<Store> {
  store ??= driverFor(serverEnv().DATABASE_URL).then(createStore);
  return store;
}
