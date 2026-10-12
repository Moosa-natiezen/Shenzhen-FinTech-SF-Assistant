/**
 * Compliance-ops alerting (T19 / Security §1-§2):
 *  - Velocity-cap hits (daily/cumulative caps, per-tx caps) raise an alert so
 *    compliance can inspect structuring patterns.
 *  - Audit-chain integrity failures raise a CRITICAL alert (tamper signal).
 *  - Screening blocks raise an alert (sanctions/PEP pipeline decisions).
 *
 * Alerts are DELIBERATELY NOT part of the money transaction: a blocked transfer
 * rolls back, but the compliance signal must survive the rollback. Each alert
 * is appended to audit_log in its own transaction (hash-chained, append-only),
 * and mirrored to the structured log stream for SIEM ingestion.
 *
 * The sink is injectable for tests; the default persists through emitAlert.
 */
import { withUserContext, SYSTEM_CTX } from "../db/rls";
import { appendAuditEvent } from "../security/audit";
import { logger } from "./logger";
import type { AnyPgDatabase } from "../db/types";

export type AlertKind =
  | "velocity_cap_hit"
  | "audit_chain_failure"
  | "screening_blocked"
  | "rate_limit_triggered";

export interface AlertEvent {
  kind: AlertKind;
  severity: "info" | "warning" | "critical";
  /** Pseudonymous ids only — the logger redacts anything PII-shaped anyway. */
  subjectUserId?: string | null;
  actorUserId?: string | null;
  details?: Record<string, unknown> | null;
}

export type AlertSink = (alert: AlertEvent) => Promise<void>;

let alertDb: AnyPgDatabase | null = null;

/** Wires the alert sink to a database (called once by the gateway builder). */
export function initAlerts(db: AnyPgDatabase): void {
  alertDb = db;
}

async function persistAndLog(alert: AlertEvent): Promise<void> {
  logger.warn(`alert.${alert.kind}`, {
    severity: alert.severity,
    subjectUserId: alert.subjectUserId ?? null,
    actorUserId: alert.actorUserId ?? null,
    ...(alert.details ?? {}),
  });
  if (!alertDb) return; // no db wired (pure unit tests): log stream only
  // audit_log INSERT policy requires a bound app.user_id; alerts emitted outside
  // a user transaction run as the synthetic system owner (I-11).
  await withUserContext(alertDb, SYSTEM_CTX, (tx) =>
    appendAuditEvent(tx, {
      action: `alert.${alert.kind}`,
      actorUserId: alert.actorUserId ?? null,
      actorRole: "system",
      entityType: "alert",
      entityId: alert.kind,
      details: {
        severity: alert.severity,
        subjectUserId: alert.subjectUserId ?? null,
        ...(alert.details ?? {}),
      },
    }),
  );
}

let sink: AlertSink = persistAndLog;

/** Test hook: replace the sink; returns the previous one. */
export function setAlertSink(next: AlertSink): AlertSink {
  const prev = sink;
  sink = next;
  return prev;
}

/**
 * Emits an alert. Never throws — alerting must not take down the operation
 * that triggered it (the operation's own transaction handles money safety).
 */
export async function emitAlert(alert: AlertEvent): Promise<void> {
  try {
    await sink(alert);
  } catch (err) {
    logger.error("alert.dispatch_failed", {
      kind: alert.kind,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
}
