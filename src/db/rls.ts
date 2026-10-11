/**
 * Postgres Row-Level Security (RLS) context plumbing.
 *
 * Every application DB access runs inside `withUserContext`, which binds
 * `app.user_id` / `app.user_role` via set_config(..., is_local=true). RLS
 * policies read them with current_setting(..., true). With no authenticated
 * context the settings are NULL, so policies deny by default (zero-trust).
 */
import { sql } from "drizzle-orm";
import type { AnyPgDatabase } from "./types";

/** Permission tiers from the design doc's Access Control Matrix. */
export type RoleTier = "student" | "sponsor" | "compliance_admin";

export interface RlsContext {
  userId: string;
  role: RoleTier;
}

const USER_ID_KEY = "app.user_id";
const USER_ROLE_KEY = "app.user_role";

/** True only when a request-scoped user context is bound AND owns the row. */
export const rowOwnerIsContextUser =
  `current_setting('${USER_ID_KEY}', true) IS NOT NULL AND user_id = current_setting('${USER_ID_KEY}', true)`;

export const selectPolicyForUserTable = `USING (${rowOwnerIsContextUser})`;

export const insertPolicyForUserTable =
  `WITH CHECK (user_id = current_setting('${USER_ID_KEY}', true))`;

/** Compliance admins may read for audit but never write user-owned rows. */
export const complianceReadPolicy = `USING (current_setting('${USER_ROLE_KEY}', true) = 'compliance_admin')`;

/**
 * Runs `fn` inside a transaction with the RLS context bound. The set_config is
 * transaction-local, so it disappears on COMMIT and ROLLBACK.
 */
export async function withUserContext<T>(
  db: AnyPgDatabase,
  ctx: RlsContext,
  fn: (tx: AnyPgDatabase) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config(${USER_ID_KEY}, ${ctx.userId}, true), set_config(${USER_ROLE_KEY}, ${ctx.role}, true)`,
    );
    return fn(tx);
  });
}

/**
 * The synthetic platform owner for external/system clearing accounts (I-11).
 * `system` owns one per-currency wallet representing money coming from / going
 * to the outside world (deposits, FX). Seeded by migration 0003.
 */
export const SYSTEM_USER_ID = "system";
export const SYSTEM_CTX: RlsContext = { userId: SYSTEM_USER_ID, role: "student" };

/**
 * Binds an RLS context onto a live transaction by setting the `app.*` GUCs
 * transaction-locally (is_local=true => cleared only at COMMIT/ROLLBACK, so it
 * survives across statements inside the tx but never leaks between transactions).
 *
 * This is the key that lets one DB transaction post legs owned by *different*
 * users while FORCE-RLS stays fully enabled: we re-bind before each owner's
 * write instead of weakening any policy.
 */
export async function bindContext(
  tx: AnyPgDatabase,
  ctx: RlsContext
): Promise<void> {
  await tx.execute(sql`select set_config('app.user_id', ${ctx.userId}, true)`);
  await tx.execute(sql`select set_config(${USER_ROLE_KEY}, ${ctx.role}, true)`);
}

/**
 * Runs `fn` inside a transaction, handing it a `bind(ctx)` callback to switch
 * the bound owner context as the work proceeds. The first operation inside the
 * callback must be a `bind` for the actor; re-bind before writing for any other
 * owner (system / student). Atomicity (I-3): everything commits or rolls back
 * as one unit.
 */
export async function withContextSwitching<T>(
  db: any,
  fn: (tx: AnyPgDatabase, bind: (ctx: RlsContext) => Promise<void>) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx: AnyPgDatabase) => {
    const bind = (ctx: RlsContext) => bindContext(tx, ctx);
    return fn(tx, bind);
  });
}
