/**
 * PGlite (in-memory Postgres) permission-model bootstrap, used by the local
 * dev server and by tests.
 *
 * PGlite connects as a Postgres SUPERUSER, and superusers bypass Row-Level
 * Security unconditionally (FORCE only binds table owners). In production the
 * Neon app role OWNS the app tables and is an ordinary (non-superuser) role:
 *   - wallets has FORCE RLS  -> policies bind the owning app role (isolation),
 *   - audit_log has plain RLS -> the owner bypasses (the hash-chain tip needs
 *     global visibility; immutability is enforced by triggers, which bind
 *     everyone including superusers),
 *   - non-owner roles are blocked by the policies and REVOKEs.
 * This helper reproduces that exact shape: a NOSUPERUSER role owning the
 * application tables, so local behavior matches the deployed system.
 */
import { sql } from "drizzle-orm";
import type { AnyPgDatabase } from "./types";

const APP_TABLES = ["user", "session", "account", "verification", "two_factor", "wallets", "audit_log"];

export async function asAppRole(db: AnyPgDatabase, roleName = "sf_app"): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(roleName)) {
    throw new Error(`invalid role name: ${roleName}`);
  }
  await db.execute(sql.raw(`create role ${roleName} nosuperuser login`));
  for (const table of APP_TABLES) {
    await db.execute(sql.raw(`alter table "${table}" owner to ${roleName}`));
  }
  await db.execute(sql.raw(`set role ${roleName}`));
}
