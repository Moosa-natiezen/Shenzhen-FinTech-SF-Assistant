/**
 * Application data tables.
 *  - wallets: user-owned, protected by FORCE RLS scoped to user_id (Phase-2
 *    ledger/FX engine builds on this).
 *  - audit_log: append-only immutable trail (triggers forbid UPDATE/DELETE and
 *    TRUNCATE); RLS allows the owning user to read their own events and
 *    compliance admins to read everything; writes only happen through the app.
 * Design doc §3.2: SPII columns (passport, national ID, bank account numbers)
 * are encrypted app-side with AES-256-GCM before insert; only ciphertext is
 * persisted — no plaintext SPII columns exist.
 */
import { numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const wallets = pgTable("wallets", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  currency: text("currency").notNull(), // ISO-4217, e.g. "CNY" (home) / "GBP" (host)
  kind: text("kind").notNull().default("home"), // home | host
  // Numeric strings: exact decimal arithmetic, never floats, for money.
  balance: numeric("balance", { precision: 20, scale: 8 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  actorUserId: text("actor_user_id"),
  actorRole: text("actor_role"),
  action: text("action").notNull(), // e.g. "fx.convert", "auth.mfa.enable"
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  // request correlation + provenance (never secrets, never full PII)
  requestId: text("request_id"),
  ip: text("ip"),
  details: text("details"), // JSON string; sensitive values only as ciphertext
  prevHash: text("prev_hash").notNull(), // sha256(prevHash || canonical payload)
  rowHash: text("row_hash").notNull().unique(),
});
