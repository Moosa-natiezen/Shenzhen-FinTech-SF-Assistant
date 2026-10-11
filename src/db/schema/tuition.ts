/**
 * Phase 3 — Tuition Routing & Credit Engine (T11-T13).
 *
 * T11 universities: verified-institution registry. Only `verified` institutions
 * may receive tuition. `bank_details_spii` stores AES-256-GCM ciphertext (never
 * plaintext SPII). Directory is readable by any bound context; the settlement
 * SPII column is only surfaced to compliance via the export enclave.
 *
 * T11 sponsor_links: sponsor<->student linkage so a sponsor gets READ-ONLY
 * access to a linked student's receipts (RLS EXISTS-scoped; forward-compatible
 * with T17's full linkage flow).
 *
 * T11 tuition_payments: immutable compliance receipts (append-only triggers,
 * like audit_log). Each row links to its double-entry ledger legs via
 * `transaction_id` and carries a `receipt_hash` for integrity (I-6).
 *
 * T13 credit_profiles: per-student encrypted SPII (national ID / passport) as
 * ciphertext; decrypted ONLY inside the Metro-2 export enclave, never persisted
 * or exported in plaintext (I-5).
 *
 * T12 r_score_snapshots: append-only R_score history. `score` is clamped to
 * [300, 850] by the engine; the [0,1] sub-score components are stored for
 * transparency/audit.
 */
import { boolean, integer, numeric, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { wallets } from "./app";

export const universities = pgTable("universities", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  country: text("country").notNull(),
  currency: text("currency").notNull(), // billing currency (host country)
  verified: boolean("verified").notNull().default(false),
  // AES-256-GCM ciphertext of the institution's settlement account (SPII).
  bankDetailsSpii: text("bank_details_spii"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sponsorLinks = pgTable(
  "sponsor_links",
  {
    id: text("id").primaryKey(),
    sponsorUserId: text("sponsor_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    studentUserId: text("student_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ sponsorStudentUnique: unique("sponsor_links_sponsor_student_uq").on(t.sponsorUserId, t.studentUserId) }),
);

export const tuitionPayments = pgTable("tuition_payments", {
  id: text("id").primaryKey(),
  transactionId: text("transaction_id").notNull(), // links the ledger legs (double-entry key)
  studentUserId: text("student_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  universityId: text("university_id").notNull().references(() => universities.id, { onDelete: "restrict" }),
  walletId: text("wallet_id").notNull().references(() => wallets.id, { onDelete: "restrict" }),
  currency: text("currency").notNull(),
  amount: numeric("amount", { precision: 20, scale: 8 }).notNull(), // exact (I-10)
  status: text("status").notNull().default("settled"), // settled | failed
  receiptHash: text("receipt_hash").notNull(), // sha256 integrity seal over the receipt
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const creditProfiles = pgTable("credit_profiles", {
  studentUserId: text("student_user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  // AES-256-GCM ciphertext (national ID / passport); plaintext only in enclave.
  nationalIdSpii: text("national_id_spii"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rScoreSnapshots = pgTable("r_score_snapshots", {
  id: text("id").primaryKey(),
  studentUserId: text("student_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  score: integer("score").notNull(), // clamped [300, 850] by the engine
  // [0,1] sub-score components (stored for transparency / recomputation audit).
  tTuition: numeric("t_tuition", { precision: 6, scale: 5 }).notNull(),
  bBills: numeric("b_bills", { precision: 6, scale: 5 }).notNull(),
  sWallet: numeric("s_wallet", { precision: 6, scale: 5 }).notNull(),
  lRepay: numeric("l_repay", { precision: 6, scale: 5 }).notNull(),
  triggerEvent: text("trigger_event").notNull(), // e.g. "tuition.settled"
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});
