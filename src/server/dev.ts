/**
 * LOCAL DEV-ONLY server: PGlite-backed gateway with production RLS semantics.
 * Production serves from src/server/index.ts (Neon). Never deploy this file.
 */
import { serve } from "@hono/node-server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createAuth } from "../auth";
import { loadEnv } from "../config/env";
import { asAppRole } from "../db/pglite-dev-role";
import { buildApp } from "./app";
import { startAuditChainMonitor } from "../observability/audit-monitor";

const env = loadEnv();
const pg = new PGlite();
const db = drizzle(pg);
await migrate(db, { migrationsFolder: "./drizzle" });
await asAppRole(db);
const auth = createAuth(db);
const app = buildApp({
  auth,
  db,
  allowedOrigins: env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
});
const port = Number(process.env.PORT ?? 3000);
// T18: periodic audit-chain integrity verification (dev: every 5 minutes).
const monitor = startAuditChainMonitor(db, 5 * 60 * 1000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`[dev] PGlite-backed sf-assistant gateway on http://localhost:${port}`);
});
process.on("SIGTERM", () => { monitor.stop(); process.exit(0); });
