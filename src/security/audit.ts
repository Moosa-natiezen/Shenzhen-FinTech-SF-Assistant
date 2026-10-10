/**
 * Append-only, tamper-evident audit trail (design doc §3.2 "Key Management &
 * Auditability" + Security §2 Risk 3: append-only immutable audit tables).
 *
 *  - Rows can only be INSERTed (DB triggers reject UPDATE/DELETE/TRUNCATE).
 *  - Hash chain: rowHash = sha256(prevHash || canonical payload); appends are
 *    serialized under a Postgres advisory lock so concurrent writers cannot
 *    fork history.
 *  - verifyAuditChain recomputes every link and reports the first break.
 */
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AnyPgDatabase } from "../db/types";

/** 63-bit namespace lock id; one constant for all audit appends. */
const AUDIT_CHAIN_LOCK = 729101884412001;
const GENESIS = "genesis";

export interface AuditEvent {
  action: string;
  entityType: string;
  entityId?: string | null;
  actorUserId?: string | null;
  actorRole?: string | null;
  requestId?: string | null;
  ip?: string | null;
  details?: Record<string, unknown> | null;
}

interface CanonicalRow extends AuditEvent {
  id: string;
  occurredAt: string; // ISO-8601 UTC
  prevHash: string;
}

function canonicalPayload(e: CanonicalRow): string {
  // Deterministic serialization: fixed key order, no whitespace.
  return JSON.stringify({
    id: e.id,
    occurredAt: e.occurredAt,
    actorUserId: e.actorUserId ?? null,
    actorRole: e.actorRole ?? null,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    requestId: e.requestId ?? null,
    ip: e.ip ?? null,
    details: e.details ?? null,
    prevHash: e.prevHash,
  });
}

export function computeRowHash(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Appends one event. Must run inside a transaction (withUserContext when an
 * authenticated actor exists). Returns the inserted row's id and hash.
 */
export async function appendAuditEvent(
  tx: AnyPgDatabase,
  event: AuditEvent,
): Promise<{ id: string; rowHash: string }> {
  const id = randomUUID();
  // Serialize appends: only one writer can chain onto the tip at a time.
  await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);
  const last = await tx.execute<{ row_hash: string }>(
    sql`select row_hash from audit_log order by ctid desc limit 1`,
  );
  const prevHash = last.rows?.[0]?.row_hash ?? GENESIS;
  const occurredAt = new Date().toISOString();
  const rowHash = computeRowHash(canonicalPayload({ ...event, id, occurredAt, prevHash }));
  await tx.execute(
    sql`insert into audit_log
        (id, occurred_at, actor_user_id, actor_role, action, entity_type, entity_id, request_id, ip, details, prev_hash, row_hash)
        values
        (${id}, ${occurredAt}, ${event.actorUserId ?? null}, ${event.actorRole ?? null}, ${event.action},
         ${event.entityType}, ${event.entityId ?? null}, ${event.requestId ?? null}, ${event.ip ?? null},
         ${event.details ? JSON.stringify(event.details) : null}, ${prevHash}, ${rowHash})`,
  );
  return { id, rowHash };
}

export interface ChainVerification {
  ok: boolean;
  brokenAtId?: string;
  length: number;
}

/** Recomputes the entire chain; returns the first break, if any. */
export async function verifyAuditChain(db: AnyPgDatabase): Promise<ChainVerification> {
  const res = await db.execute<{
    id: string;
    occurred_at: Date | string;
    actor_user_id: string | null;
    actor_role: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    request_id: string | null;
    ip: string | null;
    details: string | null;
    prev_hash: string;
    row_hash: string;
  }>(
    sql`select id, occurred_at, actor_user_id, actor_role, action, entity_type, entity_id,
               request_id, ip, details, prev_hash, row_hash
        from audit_log order by ctid asc`,
  );
  const rows = res.rows ?? [];
  let expectedPrev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== expectedPrev) {
      return { ok: false, brokenAtId: r.id, length: rows.length };
    }
    const recomputed = computeRowHash(
      canonicalPayload({
        id: r.id,
        occurredAt: new Date(r.occurred_at).toISOString(),
        actorUserId: r.actor_user_id,
        actorRole: r.actor_role,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        requestId: r.request_id,
        ip: r.ip,
        details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null,
        prevHash: r.prev_hash,
      }),
    );
    if (recomputed !== r.row_hash) {
      return { ok: false, brokenAtId: r.id, length: rows.length };
    }
    expectedPrev = r.row_hash;
  }
  return { ok: true, length: rows.length };
}
