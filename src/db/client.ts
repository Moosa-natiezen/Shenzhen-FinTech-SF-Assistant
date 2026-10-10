/**
 * Neon serverless Postgres client.
 * Design doc §1.1: Neon connection pooling for high-concurrency spikes; TLS is
 * mandatory (sslmode=require is enforced by env validation, never disabled
 * here). Transactions (SELECT ... FOR UPDATE in the Phase-2 ledger engine)
 * require the WebSocket driver, not the HTTP driver.
 */
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { loadEnv } from "../config/env";
import * as schema from "./schema";

export function createDb() {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
