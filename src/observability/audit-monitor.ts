/**
 * Audit-chain integrity monitor (T18 pen-test prep / Security §2 Risk 3).
 *
 * The hash-chained audit_log is tamper-EVIDENT (append-only triggers +
 * sha256 chain), but detection requires someone to LOOK. This job recomputes
 * the chain on an interval and:
 *  - emits a CRITICAL alert (survives independently of the checked data) on
 *    the first broken link,
 *  - emits a structured log record for SIEM ingestion either way,
 *  - exposes a one-shot runner for cron and a start/stop handle for in-process
 *    scheduling (wired by the prod/dev servers).
 *
 * Verification is read-only and streams rows in id order — safe to run against
 * production while traffic continues (writers serialize on the advisory lock;
 * a chain written entirely during the scan still verifies because each row
 * carries its prev_hash).
 */
import { verifyAuditChain } from "../security/audit";
import { emitAlert } from "./alerts";
import { logger } from "./logger";
import type { AnyPgDatabase } from "../db/types";

export interface MonitorResult {
  ok: boolean;
  length: number;
  brokenAtId?: string;
  alerted: boolean;
  durationMs: number;
}

/** Runs one verification pass. Never throws. */
export async function runAuditChainMonitor(db: AnyPgDatabase): Promise<MonitorResult> {
  const started = Date.now();
  try {
    const result = await verifyAuditChain(db);
    const durationMs = Date.now() - started;
    if (result.ok) {
      logger.info("audit_chain.verified", { length: result.length, durationMs });
      return { ok: true, length: result.length, alerted: false, durationMs };
    }
    await emitAlert({
      kind: "audit_chain_failure",
      severity: "critical",
      details: { brokenAtId: result.brokenAtId, length: result.length },
    });
    logger.error("audit_chain.broken", {
      brokenAtId: result.brokenAtId,
      length: result.length,
      durationMs,
    });
    return { ok: false, length: result.length, brokenAtId: result.brokenAtId, alerted: true, durationMs };
  } catch (err) {
    const durationMs = Date.now() - started;
    // A monitor that cannot read the chain is itself a security signal.
    logger.error("audit_chain.monitor_failed", {
      error: err instanceof Error ? err.message : "unknown",
      durationMs,
    });
    return { ok: false, length: 0, alerted: false, durationMs };
  }
}

export interface MonitorHandle {
  stop: () => void;
}

/**
 * Starts periodic verification in-process. Returns a stop handle. The first
 * pass runs immediately so a freshly-deployed instance is checked at boot.
 */
export function startAuditChainMonitor(
  db: AnyPgDatabase,
  intervalMs: number,
  onError?: (err: unknown) => void,
): MonitorHandle {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    void runAuditChainMonitor(db).catch((err) => {
      onError?.(err);
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  // Do not keep the event loop alive solely for the monitor (graceful exit).
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
