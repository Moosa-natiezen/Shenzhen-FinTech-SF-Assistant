/**
 * Phase 2 — Multi-currency wallet & ledger engine (T7–T10).
 *
 * T7 double-entry ledger: `ledger_entries` is append-only (DB triggers reject
 * UPDATE/DELETE/TRUNCATE, exactly like audit_log). Every money movement is
 * recorded as offsetting debit/credit legs grouped by a shared `transactionId`.
 * Amounts are exact NUMERIC(20,8) signed decimals — never floats (invariant
 * I-10); a debit is negative, a credit is positive. Account state is always
 * DERIVED by summing entries (balance_snapshots cache that derivation).
 *
 * T8 rate locks: `rate_locks` stores a server-computed FX rate
 * (FX_final = FX_spot × (1 + θ_margin)) bound to user + pair + amount, with a
 * 30-second expiry. Client-submitted rates are ignored; conversions must present
 * a live lock (invariant I-4).
 *
 * T10 transfers: `transfers` records sponsor deposits and cross-border transfers
 * so velocity/cumulative caps and new-payout-target step-up can be enforced and
 * audited (invariants I-7, I-8).
 */
import { numeric, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { wallets } from "./app";

export const ledgerEntries = pgTable("ledger_entries", {
  id: text("id").primaryKey(),
  // Groups the two offsetting legs of one atomic posting (double-entry).
  transactionId: text("transaction_id").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  walletId: text("wallet_id").notNull().references(() => wallets.id, { onDelete: "restrict" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  currency: text("currency").notNull(),
  // Signed exact decimal: negative = debit, positive = credit (I-10).
  amount: numeric("amount", { precision: 20, scale: 8 }).notNull(),
  entryType: text("entry_type").notNull(), // "debit" | "credit"
  kind: text("kind").notNull(), // "fx.convert" | "deposit" | "transfer"
  description: text("description"),
});

export const balanceSnapshots = pgTable("balance_snapshots", {
  id: text("id").primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  walletId: text("wallet_id").notNull().references(() => wallets.id, { onDelete: "restrict" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  currency: text("currency").notNull(),
  // Cached derivation of SUM(ledger_entries.amount) — never the source of truth.
  balance: numeric("balance", { precision: 20, scale: 8 }).notNull(),
});

export const rateLocks = pgTable("rate_locks", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  baseCurrency: text("base_currency").notNull(),
  quoteCurrency: text("quote_currency").notNull(),
  fxSpot: numeric("fx_spot", { precision: 20, scale: 8 }).notNull(),
  fxFinal: numeric("fx_final", { precision: 20, scale: 8 }).notNull(),
  margin: numeric("margin", { precision: 18, scale: 8 }).notNull(),
  amountBase: numeric("amount_base", { precision: 20, scale: 8 }).notNull(),
  feeFlat: numeric("fee_flat", { precision: 20, scale: 8 }).notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Set when the lock is consumed by a conversion; a lock is single-use.
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export const transfers = pgTable("transfers", {
  id: text("id").primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  senderUserId: text("sender_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  // Null for sponsor deposits (funding minted into the system, no recipient).
  recipientUserId: text("recipient_user_id").references(() => user.id, { onDelete: "set null" }),
  fromWalletId: text("from_wallet_id").notNull().references(() => wallets.id, { onDelete: "restrict" }),
  toWalletId: text("to_wallet_id").notNull().references(() => wallets.id, { onDelete: "restrict" }),
  fromCurrency: text("from_currency").notNull(),
  toCurrency: text("to_currency").notNull(),
  // Debit amount on the source wallet (always positive; direction is implied).
  amountFrom: numeric("amount_from", { precision: 20, scale: 8 }).notNull(),
  // Credit amount on the destination wallet.
  amountTo: numeric("amount_to", { precision: 20, scale: 8 }).notNull(),
  // Server-side locked rate applied (null when currencies match).
  fxFinal: numeric("fx_final", { precision: 20, scale: 8 }),
  feeFlat: numeric("fee_flat", { precision: 20, scale: 8 }).notNull().default("0"),
  kind: text("kind").notNull(), // "deposit" | "transfer"
  status: text("status").notNull().default("settled"), // "settled" | "blocked"
  screeningReason: text("screening_reason"),
  // Links this transfer to its ledger_entries legs (double-entry grouping key).
  transactionId: text("transaction_id").notNull(),
});
