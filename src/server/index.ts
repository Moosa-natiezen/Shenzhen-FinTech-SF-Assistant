/** Production entrypoint: Neon-backed API gateway. */
import { serve } from "@hono/node-server";
import { createAuth } from "../auth";
import { loadEnv } from "../config/env";
import { createDb } from "../db/client";
import { buildApp } from "./app";
import { startAuditChainMonitor } from "../observability/audit-monitor";

const env = loadEnv();
const db = createDb();
const auth = createAuth(db);
const app = buildApp({ auth, db, allowedOrigins: env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean) });

const port = Number(process.env.PORT ?? 3000);
// T18: audit-chain integrity monitor; interval configurable for ops (default 1h).
const monitorIntervalMs = Number(process.env.AUDIT_MONITOR_INTERVAL_MS ?? 60 * 60 * 1000);
const monitor = startAuditChainMonitor(db, monitorIntervalMs);
serve({ fetch: app.fetch, port }, () => {
  console.log(`sf-assistant gateway listening on :${port}`);
});
process.on("SIGTERM", () => { monitor.stop(); process.exit(0); });
