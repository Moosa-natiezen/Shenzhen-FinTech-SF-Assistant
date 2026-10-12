/**
 * Audit-chain integrity monitor CLI (T18).
 *
 * One-shot verification pass against the configured DATABASE_URL, suitable for
 * cron / systemd timer / CI. Exits non-zero on a broken chain so schedulers
 * page on failure. The in-process interval variant (startAuditChainMonitor)
 * is wired into the prod/dev servers for defense in depth.
 *
 * Usage: npm run audit:monitor
 */
process.env.NODE_ENV ??= "test";

import { createDb } from "../src/db/client";
import { runAuditChainMonitor } from "../src/observability/audit-monitor";

const db = createDb();
const result = await runAuditChainMonitor(db);
if (result.ok) {
  console.log(`audit chain OK (${result.length} events, ${result.durationMs}ms)`);
  process.exit(0);
}
console.error(
  `AUDIT CHAIN BROKEN at ${result.brokenAtId ?? "unknown"} (${result.length} events scanned) — critical alert raised`,
);
process.exit(1);
