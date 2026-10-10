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
